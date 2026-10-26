import {
  DEFAULT_PERSON_AI,
  isLentSubscription,
  type AppAiAssignment,
  type PersonAi,
  type PersonAiUpdate,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { PeopleChange } from './people-rules.js';
import type { StoredPerson } from './person.js';

/** The audit trail keeps the last changes only. */
export const MAX_AI_HISTORY = 50;

/** Who changes it and when (the audit trail of KBC-022). */
export interface AiChangeContext {
  readonly by: string;
  readonly now: string;
}

/** A person's AI access; people saved before KBC-022 follow the house default. */
export const aiOf = (person: StoredPerson): PersonAi =>
  person.ai ?? DEFAULT_PERSON_AI;

/** Merges a master's change and records who changed the assignment, when (ADR 0016). */
export function applyAiUpdate(
  current: PersonAi,
  patch: PersonAiUpdate,
  context: AiChangeContext,
): PersonAi {
  const next: PersonAi = {
    ...current,
    appAi: patch.appAi ?? current.appAi,
    enforced: patch.enforced ?? current.enforced,
    dailyResearches:
      patch.dailyResearches === undefined
        ? current.dailyResearches
        : patch.dailyResearches,
    paidFallback: patch.paidFallback ?? current.paidFallback,
  };
  const assignmentChanged =
    next.appAi !== current.appAi || next.enforced !== current.enforced;
  if (!assignmentChanged) return next;
  const change = {
    appAi: next.appAi,
    enforced: next.enforced,
    by: context.by,
    at: context.now,
    // The contract required the terms confirmed to lend a subscription (KBC-024 BR-7).
    ...(isLentSubscription(next.appAi) &&
      patch.subscriptionTermsAccepted && { termsAccepted: true }),
  };
  return {
    ...next,
    history: [...current.history, change].slice(-MAX_AI_HISTORY),
  };
}

/** The people a bulk assignment touches: everyone, or the ids given (all must exist). */
function targetsOf(
  people: readonly StoredPerson[],
  ids: 'all' | readonly string[],
): ReadonlySet<string> {
  if (ids === 'all') return new Set(people.map((p) => p.id));
  const known = new Set(people.map((p) => p.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0)
    throw new AppError('NOT_FOUND', 'Unknown person', {
      details: { ids: unknown },
    });
  return new Set(ids);
}

/** Gives one app AI to several people, or to everyone, at once (KBC-022 AC-12). */
export function assignAi(
  people: readonly StoredPerson[],
  request: {
    readonly ids: 'all' | readonly string[];
    readonly appAi: AppAiAssignment;
    readonly subscriptionTermsAccepted?: true;
  },
  context: AiChangeContext,
): PeopleChange<number> {
  const targets = targetsOf(people, request.ids);
  const { appAi, subscriptionTermsAccepted } = request;
  const next = people.map((person) =>
    targets.has(person.id)
      ? {
          ...person,
          ai: applyAiUpdate(
            aiOf(person),
            { appAi, subscriptionTermsAccepted },
            context,
          ),
        }
      : person,
  );
  return { people: next, result: targets.size };
}
