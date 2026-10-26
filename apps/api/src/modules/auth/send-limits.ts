import { SlidingWindows, type RateWindow } from './sliding-windows.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** KBC-014 BR-5: per email or phone, and per client address (people share one: looser). */
const IDENTIFIER_WINDOWS: readonly RateWindow[] = [
  { max: 1, ms: MINUTE },
  { max: 5, ms: HOUR },
];
const ADDRESS_WINDOWS: readonly RateWindow[] = [
  { max: 5, ms: MINUTE },
  { max: 20, ms: HOUR },
];

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
  private readonly windows: SlidingWindows;

  constructor(options: { readonly now?: () => number } = {}) {
    this.windows = new SlidingWindows(options);
  }

  /** Counts a send when both keys are under every limit; false, counting nothing, otherwise. */
  take(attempt: SendAttempt): boolean {
    return this.windows.take([
      {
        key: `${attempt.purpose}:${attempt.identifier}`,
        windows: IDENTIFIER_WINDOWS,
      },
      { key: `ip:${attempt.ip}`, windows: ADDRESS_WINDOWS },
    ]).allowed;
  }
}
