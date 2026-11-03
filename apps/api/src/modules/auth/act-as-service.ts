import type { ActAsAuditEntry, Acting } from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { ActAsAuditPort } from '../../ports/act-as-audit.js';
import type { StoredActing, StoredSession } from '../../ports/session-store.js';
import type { SessionService } from './session-service.js';
import type { PeopleService } from './people-service.js';
import {
  auditPersonOf,
  mayActAs,
  mayBeActedAs,
  type StoredPerson,
  type Viewer,
} from './person.js';

/** How long acting as a person lasts (KBC-060 BR-5). */
export const ACT_AS_MS = 30 * 60_000;

/** How long the audit is kept (ADR 0027). */
export const AUDIT_MONTHS = 12;

export interface ActAsServiceDeps {
  readonly sessions: Pick<SessionService, 'update'>;
  readonly people: PeopleService;
  readonly audit: ActAsAuditPort;
  readonly now?: () => Date;
}

type EndedBy = NonNullable<ActAsAuditEntry['endedBy']>;

/**
 * A master acting as a person (KBC-060, ADR 0027): kept on the master's own session, it
 * turns every request into the person's view, ends by itself after 30 minutes or when
 * either side loses the right, and leaves an audit line at the start, the end and on every
 * write.
 */
export class ActAsService {
  constructor(private readonly deps: ActAsServiceDeps) {}

  async start(input: {
    readonly master: Viewer;
    readonly session: StoredSession;
    readonly personId: string;
    readonly reason: string;
  }): Promise<Acting> {
    const { master, session, reason } = input;
    if (!mayActAs(master))
      throw new AppError('FORBIDDEN', 'Acting as a person is not granted');
    const person = await this.deps.people.find(input.personId);
    if (!person) throw new AppError('NOT_FOUND', 'Unknown person');
    if (!this.mayBeActedAs(person) || person.id === master.person.id)
      throw new AppError('FORBIDDEN', 'This person cannot be acted as');
    const now = this.now();
    const acting: StoredActing = {
      personId: person.id,
      reason,
      startedAt: now.toISOString(),
      endsAt: new Date(now.getTime() + ACT_AS_MS).toISOString(),
    };
    await this.deps.sessions.update({ ...session, actingAs: acting });
    await this.record('start', { master: master.person, person, acting });
    return {
      person: auditPersonOf(person),
      actor: auditPersonOf(master.person),
      reason,
      startedAt: acting.startedAt,
      endsAt: acting.endsAt,
    };
  }

  /** "Voltar para a minha conta", or "Sair" while acting (it never signs the master out). */
  async stop(session: StoredSession): Promise<boolean> {
    if (!session.actingAs) return false;
    const master = await this.deps.people.find(session.personId);
    if (!master) return false;
    await this.end(session, master, 'actor');
    return true;
  }

  /**
   * The view a request takes: the person's while acting is still valid, else the master's
   * own (an expired or no longer allowed session is ended and audited here).
   */
  async viewerFor(session: StoredSession, master: Viewer): Promise<Viewer> {
    const acting = session.actingAs;
    if (!acting) return master;
    const person = await this.deps.people.find(acting.personId);
    const expired = Date.parse(acting.endsAt) <= this.now().getTime();
    const allowed =
      person !== null && mayActAs(master) && this.mayBeActedAs(person);
    if (expired || !allowed || !person) {
      await this.end(session, master.person, expired ? 'timeout' : 'access');
      return master;
    }
    return {
      ...this.deps.people.viewerOf(person),
      actor: { viewer: master, acting },
    };
  }

  /** A write made while acting (FR-4): the route pattern and method, never the body. */
  recordWrite(viewer: Viewer, write: { method: string; route: string }) {
    const actor = viewer.actor;
    if (!actor) return Promise.resolve();
    return this.deps.audit.append({
      at: this.now().toISOString(),
      kind: 'write',
      actor: auditPersonOf(actor.viewer.person),
      person: auditPersonOf(viewer.person),
      reason: actor.acting.reason,
      method: write.method,
      route: write.route,
    });
  }

  /** The audit for masters with the grant, newest first (FR-6). */
  async audit(): Promise<ActAsAuditEntry[]> {
    return (await this.deps.audit.since(this.retentionStart())).reverse();
  }

  /** Each time someone acted as this person, newest first (FR-7, BR-7). */
  async accessesOf(personId: string) {
    const entries = (await this.deps.audit.since(this.retentionStart())).filter(
      (entry) => entry.person.id === personId,
    );
    return sessionsOf(entries).reverse();
  }

  /** Drops the audit older than 12 months (run by the janitor). */
  prune(): Promise<number> {
    return this.deps.audit.prune(this.retentionStart());
  }

  private async end(
    session: StoredSession,
    master: StoredPerson,
    endedBy: EndedBy,
  ): Promise<void> {
    const acting = session.actingAs;
    if (!acting) return;
    await this.deps.sessions.update({
      id: session.id,
      personId: session.personId,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      refreshedAt: session.refreshedAt,
    });
    const person = await this.deps.people.find(acting.personId);
    await this.record(
      'end',
      { master, person: person ?? null, acting },
      endedBy,
    );
  }

  private record(
    kind: 'start' | 'end',
    who: {
      master: StoredPerson;
      person: StoredPerson | null;
      acting: StoredActing;
    },
    endedBy?: EndedBy,
  ): Promise<void> {
    const person = who.person
      ? auditPersonOf(who.person)
      : { id: who.acting.personId, name: '', email: 'removed@invalid.test' };
    return this.deps.audit.append({
      at: this.now().toISOString(),
      kind,
      actor: auditPersonOf(who.master),
      person,
      reason: who.acting.reason,
      ...(endedBy && { endedBy }),
    });
  }

  private mayBeActedAs(person: StoredPerson): boolean {
    return mayBeActedAs(person, this.deps.people.viewerOf(person).isOwner);
  }

  private retentionStart(): Date {
    const date = this.now();
    date.setUTCMonth(date.getUTCMonth() - AUDIT_MONTHS);
    return date;
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
}

/** Start/end pairs into sessions, with how many writes each had. */
function sessionsOf(entries: readonly ActAsAuditEntry[]) {
  const sessions: {
    actorName: string;
    actorEmail: string;
    reason: string;
    startedAt: string;
    endedAt: string | null;
    writes: number;
  }[] = [];
  for (const entry of entries) {
    if (entry.kind === 'start')
      sessions.push({
        actorName: entry.actor.name,
        actorEmail: entry.actor.email,
        reason: entry.reason,
        startedAt: entry.at,
        endedAt: null,
        writes: 0,
      });
    const open = sessions.findLast(
      (s) => s.endedAt === null && s.actorEmail === entry.actor.email,
    );
    if (!open) continue;
    if (entry.kind === 'write') open.writes += 1;
    if (entry.kind === 'end') open.endedAt = entry.at;
  }
  return sessions;
}
