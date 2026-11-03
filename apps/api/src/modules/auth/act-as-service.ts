import { randomUUID } from 'node:crypto';
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
    const person = await this.target(master, input.personId);
    const now = this.now();
    const acting: StoredActing = {
      id: randomUUID(),
      personId: person.id,
      personName: person.name,
      personEmail: person.email,
      reason,
      startedAt: now.toISOString(),
      endsAt: new Date(now.getTime() + ACT_AS_MS).toISOString(),
    };
    // Audited first: no session acts without its line (NFR-2).
    await this.record('start', { master: master.person, person, acting });
    await this.deps.sessions.update({ ...session, actingAs: acting });
    return {
      person: auditPersonOf(person),
      actor: auditPersonOf(master.person),
      reason,
      startedAt: acting.startedAt,
      endsAt: acting.endsAt,
      remainingMs: ACT_AS_MS,
    };
  }

  /** Who the master may act as now, or why not (BR-1, BR-2). */
  private async target(
    master: Viewer,
    personId: string,
  ): Promise<StoredPerson> {
    if (!mayActAs(master))
      throw new AppError('FORBIDDEN', 'Acting as a person is not granted');
    const person = await this.deps.people.find(personId);
    if (!person) throw new AppError('NOT_FOUND', 'Unknown person');
    if (!this.mayBeActedAs(person) || person.id === master.person.id)
      throw new AppError('FORBIDDEN', 'This person cannot be acted as');
    // Before the first sign-in their data has no lasting owner yet (it moves at sign-in).
    if (person.lastLoginAt === null)
      throw new AppError('FORBIDDEN', 'This person has not signed in yet');
    return person;
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
      ...(actor.acting.id && { actingId: actor.acting.id }),
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
    return sessionsOf(entries, this.now()).reverse();
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
    // A person removed meanwhile is named as they were when it started.
    const person = who.person
      ? auditPersonOf(who.person)
      : {
          id: who.acting.personId,
          name: who.acting.personName ?? '',
          email: who.acting.personEmail ?? 'removed@invalid.test',
        };
    return this.deps.audit.append({
      at: this.now().toISOString(),
      kind,
      ...(who.acting.id && { actingId: who.acting.id }),
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

/**
 * Start/end pairs into sessions, with how many writes each had. A session whose end was
 * never written (it timed out with no request after, or its master lost the right) ended
 * at the latest 30 minutes after it started (BR-5).
 */
interface AccessSession {
  actorName: string;
  actorEmail: string;
  reason: string;
  startedAt: string;
  endedAt: string | null;
  writes: number;
}

function sessionsOf(entries: readonly ActAsAuditEntry[], now: Date) {
  const sessions = new Map<string, AccessSession>();
  const keyOf = (entry: ActAsAuditEntry) =>
    entry.actingId ?? `${entry.actor.email}:${entry.reason}`;
  for (const entry of entries) {
    const key = keyOf(entry);
    if (entry.kind === 'start') sessions.set(key, startedBy(entry));
    const session = sessions.get(key);
    if (!session) continue;
    if (entry.kind === 'write') session.writes += 1;
    if (entry.kind === 'end') session.endedAt = entry.at;
  }
  return [...sessions.values()].map((session) => closedBy(session, now));
}

const startedBy = (entry: ActAsAuditEntry): AccessSession => ({
  actorName: entry.actor.name,
  actorEmail: entry.actor.email,
  reason: entry.reason,
  startedAt: entry.at,
  endedAt: null,
  writes: 0,
});

/** No end written: it ended at the latest 30 minutes after it started. */
function closedBy(session: AccessSession, now: Date): AccessSession {
  if (session.endedAt !== null) return session;
  const latestEnd = Date.parse(session.startedAt) + ACT_AS_MS;
  return latestEnd <= now.getTime()
    ? { ...session, endedAt: new Date(latestEnd).toISOString() }
    : session;
}
