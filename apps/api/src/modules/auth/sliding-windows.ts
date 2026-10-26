/** At most `max` hits within any `ms` milliseconds. */
export interface RateWindow {
  readonly max: number;
  readonly ms: number;
}

/** A counter and the windows it must stay under. */
export interface RateKey {
  readonly key: string;
  readonly windows: readonly RateWindow[];
}

export type RateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAt: number };

/**
 * Sliding-window counters in memory (ADR 0011, ND-22: one API process; a restart resets
 * them). Shared by the code send limits (KBC-014) and the invitation e-mails (KBC-026).
 */
export class SlidingWindows {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly options: { readonly now?: () => number } = {}) {}

  /**
   * Counts a hit on every key when each one is under all its windows. Otherwise counts
   * nothing and says when (epoch ms) every key would fit again.
   */
  take(keys: readonly RateKey[]): RateDecision {
    const now = this.options.now?.() ?? Date.now();
    const retryAt = Math.max(
      ...keys.map(({ key, windows }) =>
        fitsAt(this.recent(key, windows, now), windows, now),
      ),
    );
    if (retryAt > now) return { allowed: false, retryAt };
    for (const { key, windows } of keys)
      this.hits.set(key, [...this.recent(key, windows, now), now]);
    return { allowed: true };
  }

  /** The key's hits inside its longest window, oldest first; older ones are forgotten. */
  private recent(
    key: string,
    windows: readonly RateWindow[],
    now: number,
  ): number[] {
    const longest = Math.max(...windows.map((w) => w.ms));
    const times = (this.hits.get(key) ?? []).filter((t) => now - t < longest);
    if (times.length === 0) this.hits.delete(key);
    else this.hits.set(key, times);
    return times;
  }
}

/** When one more hit fits every window: the hit that has to age out, plus its window. */
function fitsAt(
  times: readonly number[],
  windows: readonly RateWindow[],
  now: number,
): number {
  return Math.max(
    0,
    ...windows.map(({ max, ms }) => {
      const inside = times.filter((t) => now - t < ms);
      const blocking = inside[inside.length - max];
      return inside.length >= max && blocking !== undefined ? blocking + ms : 0;
    }),
  );
}
