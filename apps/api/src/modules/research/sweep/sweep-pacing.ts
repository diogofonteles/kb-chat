/**
 * The OpenRouter free tier allows 20 requests a minute: one start every 3.2 s stays under
 * it (KBC-030). On a refused request (429, every model of the chain busy) the sweep waits
 * and tries again, then stops with a cursor.
 */
export const SWEEP_PACE = {
  freeGapMs: 3_200,
  backoffMs: [15_000, 30_000, 60_000],
} as const;

export interface SweepClock {
  now(): number;
  /** Resolves after `ms`, or at once when the signal aborts (also when it already did). */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const realClock: SweepClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    }),
};

/**
 * Hands out request start times at least `gapMs` apart. One instance for the whole process
 * paces every free-model sweep together (the free limit is per account, not per turn;
 * architecture review of KBC-030); retries after a refusal go through it too.
 */
export class SweepPacer {
  private next = 0;

  constructor(private readonly gapMs: number = SWEEP_PACE.freeGapMs) {}

  async wait(clock: SweepClock, signal: AbortSignal): Promise<void> {
    const now = clock.now();
    const at = Math.max(now, this.next);
    this.next = at + this.gapMs;
    if (at > now) await clock.sleep(at - now, signal);
  }
}

/** The process's free-model pacer (real clock). */
export const FREE_PACER = new SweepPacer();
