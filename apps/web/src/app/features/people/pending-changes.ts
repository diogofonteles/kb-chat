import type { Feature } from '@kb-chat/contracts';

/**
 * The boxes a master checked or unchecked for one person that the server has not kept yet
 * (KBC-062): each value with the state asked for. The editor shows the saved lists with them
 * on top, and each write is built from the latest saved lists with them on top, so a change
 * never undoes another one still on its way.
 */
export interface PendingChanges {
  readonly topics: ReadonlyMap<string, boolean>;
  readonly features: ReadonlyMap<Feature, boolean>;
}

export const NO_PENDING: PendingChanges = {
  topics: new Map(),
  features: new Map(),
};

/** One box of "Acervos" or "Funcionalidades", checked (`on`) or not. */
export type Toggle =
  | { readonly field: 'topics'; readonly value: string; readonly on: boolean }
  | {
      readonly field: 'features';
      readonly value: Feature;
      readonly on: boolean;
    };

/** `saved` with the pending changes applied, in the order they were made. */
export function withPending<T>(
  saved: readonly T[],
  pending: ReadonlyMap<T, boolean>,
): T[] {
  let result = [...saved];
  for (const [value, on] of pending) {
    if (!on) result = result.filter((one) => one !== value);
    else if (!result.includes(value)) result = [...result, value];
  }
  return result;
}

/** `pending` with the change asked for; a newer change of the same box comes last. */
export function addChange(
  pending: PendingChanges,
  change: Toggle,
): PendingChanges {
  if (change.field === 'topics')
    return {
      ...pending,
      topics: moved(pending.topics, change.value, change.on),
    };
  return {
    ...pending,
    features: moved(pending.features, change.value, change.on),
  };
}

/**
 * `pending` without what a write took (`sent`), once it is over, kept or failed alike: a box
 * changed again since then stays pending for the write that follows.
 */
export function settle(
  pending: PendingChanges,
  field: Toggle['field'],
  sent: ReadonlyMap<string, boolean>,
): PendingChanges {
  const current: ReadonlyMap<string, boolean> = pending[field];
  const left = new Map(
    [...current].filter(([value, on]) => sent.get(value) !== on),
  );
  return { ...pending, [field]: left };
}

export const isEmpty = (pending: PendingChanges): boolean =>
  pending.topics.size === 0 && pending.features.size === 0;

function moved<T>(
  values: ReadonlyMap<T, boolean>,
  value: T,
  on: boolean,
): ReadonlyMap<T, boolean> {
  const next = new Map(values);
  next.delete(value);
  next.set(value, on);
  return next;
}
