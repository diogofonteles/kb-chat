import { GROQ_FREE_TIER } from '@kb-chat/contracts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A request let through: when, and the audio seconds Groq counts for it. */
interface Sent {
  readonly at: number;
  readonly seconds: number;
}

export type PaceVerdict =
  { readonly ok: true } | { readonly ok: false; readonly retryAfterMs: number };

type Limits = Record<keyof typeof GROQ_FREE_TIER, number>;

/**
 * The free tier's pace (KBC-037 FR-3): at most 20 requests a minute, 7,200 audio seconds an
 * hour and 28,800 a day, over sliding windows. In memory: after a restart Groq's own 429 and
 * its `retry-after` hold the line until the windows fill again.
 */
export class GroqPacer {
  private sent: Sent[] = [];

  constructor(private readonly limits: Limits = GROQ_FREE_TIER) {}

  /** Lets a request of `audioMs` through now and counts it, or says how long to wait. */
  admit(audioMs: number, now: number): PaceVerdict {
    this.sent = this.sent.filter((one) => one.at > now - DAY_MS);
    const seconds = audioMs / 1000;
    const wait = Math.max(
      this.waitForCount(now),
      this.waitForSeconds({ now, seconds, windowMs: HOUR_MS }),
      this.waitForSeconds({ now, seconds, windowMs: DAY_MS }),
    );
    if (wait > 0) return { ok: false, retryAfterMs: wait };
    this.sent.push({ at: now, seconds });
    return { ok: true };
  }

  /** Until the oldest request of the last minute leaves it, when the minute is full. */
  private waitForCount(now: number): number {
    const inMinute = this.sent.filter((one) => one.at > now - MINUTE_MS);
    if (inMinute.length < this.limits.requestsPerMinute) return 0;
    const oldest = inMinute[inMinute.length - this.limits.requestsPerMinute];
    return oldest ? oldest.at + MINUTE_MS - now : MINUTE_MS;
  }

  /** Until enough audio seconds leave the window for `seconds` more to fit. */
  private waitForSeconds(input: {
    now: number;
    seconds: number;
    windowMs: number;
  }): number {
    const { now, seconds, windowMs } = input;
    const limit =
      windowMs === HOUR_MS
        ? this.limits.audioSecondsPerHour
        : this.limits.audioSecondsPerDay;
    const inWindow = this.sent.filter((one) => one.at > now - windowMs);
    let used = inWindow.reduce((sum, one) => sum + one.seconds, 0);
    if (used + seconds <= limit) return 0;
    for (const one of inWindow) {
      used -= one.seconds;
      if (used + seconds <= limit) return one.at + windowMs - now;
    }
    return windowMs;
  }
}
