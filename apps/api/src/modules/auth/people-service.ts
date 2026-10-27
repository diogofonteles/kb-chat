import type { InvitePreset } from '@kb-chat/contracts';
import { randomUUID } from 'node:crypto';
import type {
  AppAiAssignment,
  Invitation,
  PersonUpdate,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { VerifiedIdentity } from '../../ports/identity-verifier.js';
import type { PeopleStorePort } from '../../ports/people-store.js';
import {
  OWNER_PRINCIPAL,
  isMaster,
  peopleDocumentSchema,
  type StoredPerson,
  type Viewer,
} from './person.js';
import * as rules from './people-rules.js';
import { assignAi } from './person-ai.js';
import type { PeopleChange } from './people-rules.js';

/** Permission reads are at most this old (BR-4: a change applies within a minute). */
export const PEOPLE_CACHE_MS = 60_000;

export interface PeopleServiceDeps {
  readonly store: PeopleStorePort;
  /** KB_CHAT_OWNER_EMAIL: the first master, protected from demotion and removal. */
  readonly ownerEmail?: string;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

interface Loaded {
  readonly people: readonly StoredPerson[];
  readonly at: number;
}

/**
 * Who may sign in and what they may use (KBC-010). Kept in memory and read again from
 * `people.json` when older than a minute; changes apply one after the other.
 */
export class PeopleService {
  private loaded: Loaded | null = null;
  private writing: Promise<unknown> = Promise.resolve();
  private readonly ownerEmail: string | undefined;

  constructor(private readonly deps: PeopleServiceDeps) {
    this.ownerEmail = deps.ownerEmail?.toLowerCase();
  }

  async list(): Promise<readonly StoredPerson[]> {
    return (await this.current()).people;
  }

  async find(id: string): Promise<StoredPerson | null> {
    return (await this.list()).find((p) => p.id === id) ?? null;
  }

  isOwner(person: StoredPerson): boolean {
    return person.email === this.ownerEmail;
  }

  /** The owner keeps the `owner` alias of the data written before logins (ADR 0008). */
  viewerOf(person: StoredPerson): Viewer {
    const isOwner = this.isOwner(person);
    const principal = isOwner
      ? OWNER_PRINCIPAL
      : (person.principal ?? person.sub ?? person.id);
    return { person, principal, isOwner };
  }

  signIn(identity: VerifiedIdentity): Promise<StoredPerson> {
    return this.change((people) => rules.signIn(people, identity, this.now()));
  }

  /**
   * The person whose email (lower case) or E.164 phone this is, if any (KBC-014). A phone
   * shared by two people names nobody: phones are not verified yet (ADR 0011).
   */
  async findByIdentifier(identifier: string): Promise<StoredPerson | null> {
    const people = await this.list();
    const byEmail = people.find((p) => p.email === identifier);
    if (byEmail) return byEmail;
    const byPhone = people.filter((p) => p.phone === identifier);
    return byPhone.length === 1 ? (byPhone[0] ?? null) : null;
  }

  async masterEmails(): Promise<string[]> {
    return (await this.list()).filter(isMaster).map((p) => p.email);
  }

  /** An approved access request becomes a person with the invite defaults (BR-6). */
  approve(approved: rules.ApprovedRequest): Promise<StoredPerson> {
    return this.change((people) =>
      rules.approve(people, approved, this.context()),
    );
  }

  /** A sign-in with a one-time code: fixes the principal and the last access. */
  signInWithCode(id: string): Promise<StoredPerson> {
    return this.change((people) => rules.codeSignIn(people, id, this.now()));
  }

  /** An invitation; with a preset, the person is set up at once (KBC-028). */
  invite(
    email: string,
    invitedBy: string,
    preset?: InvitePreset,
  ): Promise<StoredPerson> {
    return this.change((people) => {
      const invited = rules.invite(
        people,
        { email, invitedBy },
        this.context(),
      );
      if (!preset) return invited;
      return rules.applyPreset(
        invited.people,
        {
          id: invited.result.id,
          preset,
          context: { by: invitedBy, now: this.now() },
          withPreferences: true,
        },
        this.ownerEmail,
      );
    });
  }

  /** A profile applied to someone already there (KBC-028 FR-4). */
  applyPreset(
    id: string,
    preset: InvitePreset,
    options: { readonly by: string; readonly withPreferences: boolean },
  ): Promise<StoredPerson> {
    const context = { by: options.by, now: this.now() };
    return this.change((people) =>
      rules.applyPreset(
        people,
        { id, preset, context, withPreferences: options.withPreferences },
        this.ownerEmail,
      ),
    );
  }

  /** A master's change; `by` (their e-mail) goes to the AI audit trail. */
  update(
    id: string,
    patch: PersonUpdate,
    by = 'system',
  ): Promise<StoredPerson> {
    const context = { by, now: this.now() };
    return this.change((people) =>
      rules.update(people, { id, patch, context }, this.ownerEmail),
    );
  }

  /** One app AI for several people or for everyone (KBC-022); answers how many changed. */
  assignAi(
    request: {
      readonly ids: 'all' | readonly string[];
      readonly appAi: AppAiAssignment;
      /** Lending a subscription: its terms were confirmed (KBC-024). */
      readonly subscriptionTermsAccepted?: true;
    },
    by: string,
  ): Promise<number> {
    const context = { by, now: this.now() };
    return this.change((people) => assignAi(people, request, context));
  }

  /**
   * The person a principal belongs to, from memory (refreshed by every request's guard), for
   * code that cannot wait: the provider registry choosing an AI (KBC-022).
   */
  cachedByPrincipal(principal: string): Viewer | null {
    for (const person of this.loaded?.people ?? []) {
      const viewer = this.viewerOf(person);
      if (viewer.principal === principal) return viewer;
    }
    return null;
  }

  revoke(id: string): Promise<StoredPerson> {
    return this.change((people) => rules.revoke(people, id, this.ownerEmail));
  }

  /** Keeps the outcome of the last invitation e-mail (KBC-026). */
  recordInvitation(id: string, invitation: Invitation): Promise<StoredPerson> {
    return this.change((people) =>
      rules.recordInvitation(people, id, invitation),
    );
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private context() {
    return { now: this.now(), newId: this.deps.newId ?? randomUUID };
  }

  private async current(): Promise<Loaded> {
    const age = Date.now() - (this.loaded?.at ?? 0);
    if (this.loaded && age < PEOPLE_CACHE_MS) return this.loaded;
    await this.writing;
    return this.reload();
  }

  /** Reads the file, adds the owner when missing and saves that once. */
  private async reload(): Promise<Loaded> {
    const raw = await this.deps.store.read();
    const parsed = peopleDocumentSchema.safeParse(raw ?? undefined);
    if (raw !== null && !parsed.success)
      throw new AppError('INTERNAL', 'people.json is invalid');
    const stored = parsed.success ? parsed.data.people : [];
    const people = rules.ensureOwner(stored, {
      ownerEmail: this.ownerEmail,
      ...this.context(),
    });
    if (people !== stored) await this.persist(people);
    this.loaded = { people, at: Date.now() };
    return this.loaded;
  }

  private change<T>(
    apply: (people: readonly StoredPerson[]) => PeopleChange<T>,
  ): Promise<T> {
    const run = this.writing.then(async () => {
      const { people } = await this.reload();
      const changed = apply(people);
      await this.persist(changed.people);
      this.loaded = { people: changed.people, at: Date.now() };
      return changed.result;
    });
    this.writing = run.catch(() => undefined);
    return run;
  }

  private persist(people: readonly StoredPerson[]): Promise<void> {
    return this.deps.store.write({ version: 1, people });
  }
}
