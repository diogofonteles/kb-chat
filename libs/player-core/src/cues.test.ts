import { describe, expect, it } from 'vitest';
import {
  MAX_EXTRAPOLATION_MS,
  cueAt,
  interpolate,
  lastStartedAt,
  parseWebVtt,
  vttTimeToMs,
  type Cue,
} from './cues.js';

const span = (startMs: number, endMs: number) => ({ startMs, endMs });

describe('lastStartedAt (KBC-038 FR-3: binary search)', () => {
  const spans = [span(0, 900), span(1_000, 1_900), span(2_000, 2_900)];

  it('finds the last span that started at or before the time', () => {
    expect(lastStartedAt(spans, 0)).toBe(0);
    expect(lastStartedAt(spans, 999)).toBe(0);
    expect(lastStartedAt(spans, 1_000)).toBe(1);
    expect(lastStartedAt(spans, 1_950)).toBe(1);
    expect(lastStartedAt(spans, 99_000)).toBe(2);
  });

  it('is -1 before the first span and in an empty list', () => {
    expect(lastStartedAt([span(500, 900)], 499)).toBe(-1);
    expect(lastStartedAt([], 10)).toBe(-1);
  });

  it('agrees with a linear scan on a long list', () => {
    const many = Array.from({ length: 1_501 }, (_, i) =>
      span(i * 4_800, i * 4_800 + 4_000),
    );
    for (const ms of [0, 1, 4_799, 4_800, 3_600_000, 7_200_000, 7_300_000]) {
      const linear = many.reduce(
        (found, one, index) => (one.startMs <= ms ? index : found),
        -1,
      );
      expect(lastStartedAt(many, ms)).toBe(linear);
    }
  });
});

describe('cueAt', () => {
  const cues: Cue[] = [
    { startMs: 1_000, endMs: 2_000, text: 'um' },
    { startMs: 3_000, endMs: 4_000, text: 'dois' },
  ];

  it('gives the cue on screen, and none in a gap, before or after', () => {
    expect(cueAt(cues, 1_000)?.text).toBe('um');
    expect(cueAt(cues, 1_999)?.text).toBe('um');
    expect(cueAt(cues, 2_000)).toBeNull();
    expect(cueAt(cues, 3_500)?.text).toBe('dois');
    expect(cueAt(cues, 500)).toBeNull();
    expect(cueAt(cues, 4_000)).toBeNull();
  });
});

describe('parseWebVtt', () => {
  it('reads the cues the API writes, lines and entities included', () => {
    const vtt =
      'WEBVTT\n\n1\n00:00:00.100 --> 00:00:01.500\nA &amp; B &lt;c&gt;\n\n' +
      '2\n01:02:03.004 --> 01:02:05.000\nlinha 1\nlinha 2\n';
    expect(parseWebVtt(vtt)).toEqual([
      { startMs: 100, endMs: 1_500, text: 'A & B <c>' },
      { startMs: 3_723_004, endMs: 3_725_000, text: 'linha 1\nlinha 2' },
    ]);
  });

  it('takes cues without ids, short times, CRLF, a BOM, tags and settings', () => {
    const vtt =
      '\uFEFFWEBVTT - legenda\r\n\r\nNOTE uma nota\r\n\r\n' +
      '00:02.000 --> 00:03.000 align:start\r\n<v Mestre>Olá&nbsp;mundo</v>\r\n\r\n' +
      '00:00.500 --> 00:01.000\r\nantes';
    expect(parseWebVtt(vtt)).toEqual([
      { startMs: 500, endMs: 1_000, text: 'antes' },
      { startMs: 2_000, endMs: 3_000, text: 'Olá\u00a0mundo' },
    ]);
  });

  it('skips cues without text or with broken times, and a file that is not WebVTT', () => {
    expect(
      parseWebVtt(
        'WEBVTT\n\n00:00.000 --> 00:01.000\n\n\nxx --> yy\ntexto\n\n00:01.000 --> 00:02.000\n<b></b>',
      ),
    ).toEqual([]);
    expect(parseWebVtt('1\n00:00.000 --> 00:01.000\noi')).toEqual([]);
  });

  it('decodes the direction marks', () => {
    const [cue] = parseWebVtt(
      'WEBVTT\n\n00:00.000 --> 00:01.000\na&lrm;b&rlm;',
    );
    expect(cue?.text).toBe('a\u200eb\u200f');
  });
});

describe('vttTimeToMs', () => {
  it('reads hours, minutes, seconds and ms', () => {
    expect(vttTimeToMs('01:02:03.004')).toBe(3_723_004);
    expect(vttTimeToMs('12:34.500')).toBe(754_500);
  });
});

describe('interpolate (ADR 0025 §4)', () => {
  it('moves on from the last report at the playback rate', () => {
    const first = interpolate(null, {
      reportedMs: 10_000,
      nowMs: 500,
      rate: 1,
    });
    expect(first.positionMs).toBe(10_000);
    const later = interpolate(first.anchor, {
      reportedMs: 10_000,
      nowMs: 700,
      rate: 1.5,
    });
    expect(later.positionMs).toBe(10_300);
    expect(later.anchor).toBe(first.anchor);
  });

  it('takes a new report as the new anchor', () => {
    const first = interpolate(null, { reportedMs: 10_000, nowMs: 0, rate: 1 });
    const next = interpolate(first.anchor, {
      reportedMs: 10_250,
      nowMs: 260,
      rate: 1,
    });
    expect(next.anchor).toEqual({ reportedMs: 10_250, atMs: 260 });
    expect(next.positionMs).toBe(10_250);
  });

  it('never guesses more than a second ahead, nor goes back in time', () => {
    const first = interpolate(null, { reportedMs: 0, nowMs: 1_000, rate: 2 });
    expect(
      interpolate(first.anchor, { reportedMs: 0, nowMs: 9_000, rate: 2 })
        .positionMs,
    ).toBe(MAX_EXTRAPOLATION_MS * 2);
    expect(
      interpolate(first.anchor, { reportedMs: 0, nowMs: 900, rate: 1 })
        .positionMs,
    ).toBe(0);
  });
});
