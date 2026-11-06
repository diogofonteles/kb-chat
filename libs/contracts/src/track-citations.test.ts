import { describe, expect, it } from 'vitest';
import {
  SOURCE_CITATION,
  TRACK_ANCHOR,
  answerMediaSchema,
  clockSeconds,
  formatTrackClock,
  trackPassageSchema,
} from './track-citations.js';

describe('track citations (KBC-099, ADR 0035 §6)', () => {
  it('writes a track clock in whole seconds, with hours only past one', () => {
    expect(formatTrackClock(0)).toBe('0:00');
    expect(formatTrackClock(41_999)).toBe('0:41');
    expect(formatTrackClock(508_000)).toBe('8:28');
    expect(formatTrackClock(3_725_000)).toBe('1:02:05');
    expect(formatTrackClock(-5)).toBe('0:00');
  });

  it('reads the seconds of a clock, and nothing of a time that is not one', () => {
    expect(clockSeconds('0:41')).toBe(41);
    expect(clockSeconds('8:15')).toBe(495);
    expect(clockSeconds('1:02:05')).toBe(3725);
    expect(clockSeconds('7:77')).toBeNull();
    expect(clockSeconds('1:61:00')).toBeNull();
    expect(clockSeconds('41')).toBeNull();
    expect(clockSeconds('1:2:3:4')).toBeNull();
    expect(clockSeconds('a:10')).toBeNull();
  });

  it('finds anchors and citations, plain or with a passage', () => {
    const text = '[0:41] O ritmo [3] e [12@8:15], [2@1:02:05].';
    expect(
      [...text.matchAll(new RegExp(TRACK_ANCHOR.source, 'g'))].map((m) => m[1]),
    ).toEqual(['0:41']);
    expect(
      [...text.matchAll(new RegExp(SOURCE_CITATION.source, 'g'))].map((m) => [
        m[1],
        m[2],
      ]),
    ).toEqual([
      ['3', undefined],
      ['12', '8:15'],
      ['2', '1:02:05'],
    ]);
  });

  it('validates a passage and a source track', () => {
    expect(
      trackPassageSchema.safeParse({
        at: '0:41',
        startMs: 41_300,
        endMs: 70_000,
      }).success,
    ).toBe(true);
    expect(
      trackPassageSchema.safeParse({ at: '0:41', startMs: -1, endMs: 0 })
        .success,
    ).toBe(false);
    expect(
      answerMediaSchema.safeParse({
        mediaId: '0b9c1f7e-1111-4a2b-8c3d-000000000001',
        kind: 'track',
        recordingTitle: 'Palestra',
        durationMs: 1,
        confidence: 'low',
      }).success,
    ).toBe(true);
  });
});
