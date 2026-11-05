import { describe, expect, it } from 'vitest';
import { GroqPacer } from './groq-pacer.js';

const T0 = 1_800_000_000_000;

describe("GroqPacer: the free tier's pace (KBC-037 FR-3)", () => {
  it('lets 20 requests through in a minute and asks the 21st to wait for the oldest to leave', () => {
    const pacer = new GroqPacer();
    for (let n = 0; n < 20; n++)
      expect(pacer.admit(1_000, T0 + n * 1_000)).toEqual({ ok: true });
    expect(pacer.admit(1_000, T0 + 20_000)).toEqual({
      ok: false,
      retryAfterMs: 40_000,
    });
    expect(pacer.admit(1_000, T0 + 60_001)).toEqual({ ok: true });
  });

  it('holds the audio seconds of an hour to 7,200', () => {
    const pacer = new GroqPacer({
      requestsPerMinute: 1_000,
      audioSecondsPerHour: 7_200,
      audioSecondsPerDay: 28_800,
    });
    // 258 chunks of 28 s are 7,224 s: the last one waits for the first to leave the hour.
    for (let n = 0; n < 257; n++)
      expect(pacer.admit(28_000, T0 + n).ok).toBe(true);
    const verdict = pacer.admit(28_000, T0 + 257);
    expect(verdict).toEqual({ ok: false, retryAfterMs: 3_600_000 - 257 });
  });

  it('holds the audio seconds of a day to 28,800', () => {
    const pacer = new GroqPacer({
      requestsPerMinute: 1_000,
      audioSecondsPerHour: 1_000_000,
      audioSecondsPerDay: 28_800,
    });
    expect(pacer.admit(28_800_000, T0).ok).toBe(true);
    const verdict = pacer.admit(1_000, T0 + 1_000);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.retryAfterMs).toBe(86_400_000 - 1_000);
  });

  it('does not count a request it refused', () => {
    const pacer = new GroqPacer({
      requestsPerMinute: 1,
      audioSecondsPerHour: 7_200,
      audioSecondsPerDay: 28_800,
    });
    expect(pacer.admit(1_000, T0).ok).toBe(true);
    expect(pacer.admit(1_000, T0 + 1).ok).toBe(false);
    expect(pacer.admit(1_000, T0 + 60_001).ok).toBe(true);
  });
});
