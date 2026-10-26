interface Window {
  readonly max: number;
  readonly ms: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** KBC-014 BR-5: per email or phone, and per client address (people share one: looser). */
const IDENTIFIER_WINDOWS: readonly Window[] = [
  { max: 1, ms: MINUTE },
  { max: 5, ms: HOUR },
];
const ADDRESS_WINDOWS: readonly Window[] = [
  { max: 5, ms: MINUTE },
  { max: 20, ms: HOUR },
];
const LONGEST_MS = HOUR;

/** Who asks for a code to be sent. */
export interface SendAttempt {
  /** Sign-up and sign-in codes count apart: approval may come minutes after the sign-up. */
  readonly purpose: 'signup' | 'login';
  readonly identifier: string;
  readonly ip: string;
}

/**
 * How many codes may go out (KBC-014 BR-5, ADR 0011). In memory: one API process (ND-22);
 * a restart resets the counters, the code's own lifetime and attempts stay on disk.
 */
export class SendLimits {
  private readonly sent = new Map<string, number[]>();

  constructor(private readonly options: { readonly now?: () => number } = {}) {}

  /** Counts a send when both keys are under every limit; false, counting nothing, otherwise. */
  take(attempt: SendAttempt): boolean {
    const now = this.options.now?.() ?? Date.now();
    const keys: [string, readonly Window[]][] = [
      [`${attempt.purpose}:${attempt.identifier}`, IDENTIFIER_WINDOWS],
      [`ip:${attempt.ip}`, ADDRESS_WINDOWS],
    ];
    const allowed = keys.every(([key, windows]) =>
      this.fits(this.recent(key, now), windows, now),
    );
    if (allowed)
      for (const [key] of keys)
        this.sent.set(key, [...this.recent(key, now), now]);
    return allowed;
  }

  private fits(
    times: readonly number[],
    windows: readonly Window[],
    now: number,
  ) {
    return windows.every(
      ({ max, ms }) => times.filter((t) => now - t < ms).length < max,
    );
  }

  /** The key's sends in the last hour; older ones are forgotten. */
  private recent(key: string, now: number): number[] {
    const times = (this.sent.get(key) ?? []).filter(
      (t) => now - t < LONGEST_MS,
    );
    if (times.length === 0) this.sent.delete(key);
    return times;
  }
}
