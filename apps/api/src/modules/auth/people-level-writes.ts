import type {
  InvitationPreset,
  PersonLevelVia,
  PersonUpdate,
  Role,
} from '@kb-chat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../../app-error.js';
import type { StoredPerson } from './person.js';

/** A person's role and collections, and the levels a preset or a change names (KBC-109). */
export interface LevelGrant {
  readonly role: Role;
  readonly topics: readonly string[];
  readonly levels?: Readonly<Record<string, string>>;
}

/** One person's levels before and after a write, for the audit. */
export interface LevelChangeRecord {
  readonly before: StoredPerson;
  readonly after: StoredPerson;
  readonly by: string;
  readonly via: PersonLevelVia;
}

/** What the access-levels module checks and records around a person's levels. */
export interface PersonLevelRules {
  /** Throws VALIDATION_FAILED unless every entry names a level of that collection's scale. */
  assertLevels(levels: Readonly<Record<string, string>>): void;
  /**
   * KBC-109 BR-1, BR-5: every level of a preset names a collection with a scale that its
   * collections reach, and one of its levels; a master preset holds none.
   */
  assertPresetLevels(preset: LevelGrant): void;
  /**
   * The levels a grant writes (KBC-109 BR-2, BR-3): for each collection with a scale it
   * reaches, the level named when it exists, else the one `held` when valid and not named,
   * else the lowest. A master gets none.
   */
  resolve(
    grant: LevelGrant & { readonly held?: Readonly<Record<string, string>> },
  ): Record<string, string>;
  /** Audits each level that changed (FR-10), and where it was set (KBC-109 BR-4). */
  recordChange(change: LevelChangeRecord): Promise<void>;
  /**
   * Runs a person's level write in the levels write queue (KBC-109 R1-6): the scale it reads,
   * the person before and the audit line cannot be overtaken by a scale change or a bulk.
   */
  serial<T>(work: () => Promise<T>): Promise<T>;
}

/** The write in the levels queue, or as it is when there is no levels module. */
export const serialLevels = <T>(
  rules: PersonLevelRules | undefined,
  work: () => Promise<T>,
): Promise<T> => (rules ? rules.serial(work) : work());

const masterHoldsNoLevels = () =>
  new AppError('VALIDATION_FAILED', 'A master holds no levels');

export function assertPresetLevels(
  rules: PersonLevelRules | undefined,
  preset: InvitationPreset,
): void {
  if (!preset.levels || Object.keys(preset.levels).length === 0) return;
  if (!rules)
    throw new AppError('VALIDATION_FAILED', 'Levels are not available');
  rules.assertPresetLevels(preset);
}

/** PATCH: levels of a known scale, never on someone who is or becomes a master (R1-4). */
export function assertPersonLevels(
  rules: PersonLevelRules | undefined,
  change: {
    readonly role: Role | undefined;
    readonly levels?: PersonUpdate['levels'];
  },
): void {
  const { role, levels } = change;
  if (levels === undefined) return;
  if (!rules)
    throw new AppError('VALIDATION_FAILED', 'Levels are not available');
  if (role === 'master' && Object.keys(levels).length > 0)
    throw masterHoldsNoLevels();
  rules.assertLevels(levels);
}

/** The preset with the levels it writes (KBC-109 FR-2); none without the levels module. */
export function withLevels(
  rules: PersonLevelRules | undefined,
  preset: InvitationPreset,
  held?: Readonly<Record<string, string>>,
): InvitationPreset {
  const { levels: named, ...rest } = preset;
  const levels = rules?.resolve({ ...preset, levels: named, held }) ?? {};
  return Object.keys(levels).length > 0 ? { ...rest, levels } : rest;
}

/**
 * A change of collections, or a master becoming a member, writes the lowest level of each
 * collection with a scale now reached without a valid one, so the grant is recorded
 * (KBC-109 AC-5, BR-4, R1-5).
 */
export function withGrantedLevels(
  rules: PersonLevelRules | undefined,
  before: StoredPerson | null,
  body: PersonUpdate,
): PersonUpdate {
  if (!before || !rules) return body;
  const demoted = before.role === 'master' && body.role === 'member';
  if (!body.topics && !demoted) return body;
  const granted = rules.resolve({
    role: body.role ?? before.role,
    topics: body.topics ?? before.topics,
    levels: body.levels ?? {},
    // A master made member never gets back a level from before (R2-2): the lowest.
    held: demoted ? {} : before.levels,
  });
  const levels = { ...body.levels, ...granted };
  return Object.keys(levels).length > 0 ? { ...body, levels } : body;
}

/**
 * A person's levels changed: one audit line per collection (KBC-109 BR-4). people.json is
 * written first (the audit file cannot join it): a failed record is logged with what changed
 * and fails the request (ADR 0036 §11).
 */
export async function recordLevels(
  rules: PersonLevelRules | undefined,
  change: LevelChangeRecord & {
    readonly log: FastifyBaseLogger;
    /** What the log says when the audit fails (an undo says it was done). */
    readonly message?: string;
  },
): Promise<void> {
  const { log, message, ...record } = change;
  await rules?.recordChange(record).catch((err: unknown) => {
    log.error(
      {
        err,
        person: record.after.id,
        before: record.before.levels ?? {},
        after: record.after.levels ?? {},
      },
      message ?? 'person levels changed but not audited',
    );
    throw err;
  });
}

/**
 * What undoing a profile writes (R2-1): the person as before it, except a level someone else
 * changed after it was applied, which stays.
 */
export function undoneProfile(state: {
  readonly before: StoredPerson;
  readonly applied: StoredPerson;
  readonly now: StoredPerson;
}): StoredPerson {
  const { before, applied, now } = state;
  const roots = new Set(
    [before, applied, now].flatMap((one) => Object.keys(one.levels ?? {})),
  );
  const levels: Record<string, string> = {};
  for (const root of roots) {
    const current = now.levels?.[root];
    const kept =
      current === applied.levels?.[root] ? before.levels?.[root] : current;
    if (kept !== undefined) levels[root] = kept;
  }
  return { ...before, levels };
}
