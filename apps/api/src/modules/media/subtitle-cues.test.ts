import { describe, expect, it } from 'vitest';
import {
  PILOT_FIXTURES,
  PILOT_TERMS,
  pilotRaw,
} from '../../../test/transcript-fixtures.js';
import type {
  DerivedSegment,
  DerivedWord,
} from '../../ports/transcript-store.js';
import {
  SUBTITLE_RULES,
  cuesOf,
  formatWebVtt,
  linesOf,
  vttTime,
  type SubtitleCue,
} from './subtitle-cues.js';
import { deriveTranscript } from './transcript-filter.js';

const segmentAt = (
  startMs: number,
  endMs: number,
  text: string,
): DerivedSegment => ({
  startMs,
  endMs,
  text,
  avgLogprob: -0.2,
  compressionRatio: 1.3,
  noSpeechProb: 0,
});

/** Words of `text`, one every `stepMs` from `startMs`, each lasting `lengthMs`. */
function wordsOf(
  text: string,
  at: { startMs: number; stepMs?: number; lengthMs?: number; segment?: number },
): DerivedWord[] {
  const step = at.stepMs ?? 400;
  return text.split(' ').map((word, index) => ({
    segment: at.segment ?? 0,
    startMs: at.startMs + index * step,
    endMs: at.startMs + index * step + (at.lengthMs ?? 300),
    text: word,
    probability: 0.9,
  }));
}

const flat = (cue: SubtitleCue) => cue.text.replace('\n', ' ');

function expectWithinRules(cues: readonly SubtitleCue[]): void {
  cues.forEach((cue, index) => {
    expect(flat(cue).length).toBeLessThanOrEqual(SUBTITLE_RULES.maxCueChars);
    expect(cue.endMs - cue.startMs).toBeLessThanOrEqual(
      SUBTITLE_RULES.maxCueMs,
    );
    expect(cue.endMs).toBeGreaterThanOrEqual(cue.startMs);
    for (const line of cue.text.split('\n'))
      expect(line.length).toBeLessThanOrEqual(SUBTITLE_RULES.maxLineChars);
    const next = cues[index + 1];
    if (next) expect(next.startMs).toBeGreaterThanOrEqual(cue.startMs);
    if (next && next.startMs > cue.startMs)
      expect(cue.endMs).toBeLessThanOrEqual(next.startMs);
  });
}

describe('cuesOf (KBC-038 FR-1, ADR 0023 §8)', () => {
  it.each(PILOT_FIXTURES)(
    'keeps every cue of the pilot fixture %s within 84 characters, 6 s and 2 lines, in order (AC-1)',
    (name) => {
      const derived = deriveTranscript(pilotRaw(name), PILOT_TERMS);
      const cues = cuesOf(derived);
      expect(cues.length).toBeGreaterThan(0);
      expectWithinRules(cues);
      // Nothing of the text is lost: the cues hold every kept word, in order.
      const words = derived.words.map((word) => word.text).join(' ');
      expect(cues.map(flat).join(' ')).toBe(words);
    },
  );

  it('starts a new cue after a sentence ends', () => {
    const words = wordsOf('Existia um rei. Ele tinha uma conselheira.', {
      startMs: 0,
    });
    const cues = cuesOf({ segments: [segmentAt(0, 3_000, '')], words });
    expect(cues.map((cue) => cue.text)).toEqual([
      'Existia um rei.',
      'Ele tinha uma conselheira.',
    ]);
  });

  it('starts a new cue at a silence of 0.5 s, not at a shorter one', () => {
    const words = [
      ...wordsOf('a palavra', { startMs: 0 }),
      // 400 ms after "palavra" ends (700): same cue.
      ...wordsOf('segue junto', { startMs: 1_100 }),
      // 500 ms after "junto" ends (1 800): new cue.
      ...wordsOf('depois da pausa', { startMs: 2_300 }),
    ];
    const cues = cuesOf({ segments: [segmentAt(0, 4_000, '')], words });
    expect(cues.map((cue) => cue.text)).toEqual([
      'a palavra segue junto',
      'depois da pausa',
    ]);
  });

  it('caps a stretched word at 1.2 s, so the pause after it still splits', () => {
    const words: DerivedWord[] = [
      { segment: 0, startMs: 0, endMs: 300, text: 'um', probability: 1 },
      // Whisper stretched "longo" over a 3 s pause.
      { segment: 0, startMs: 400, endMs: 4_000, text: 'longo', probability: 1 },
      { segment: 0, startMs: 4_000, endMs: 4_300, text: 'fim', probability: 1 },
    ];
    const cues = cuesOf({ segments: [segmentAt(0, 4_300, '')], words });
    expect(cues).toEqual([
      { startMs: 0, endMs: 1_600, text: 'um longo' },
      { startMs: 4_000, endMs: 4_300, text: 'fim' },
    ]);
  });

  it('never makes a cue longer than 6 s, even without pauses or full stops', () => {
    const text = Array.from({ length: 30 }, (_, i) => `p${i}`).join(' ');
    const cues = cuesOf({
      segments: [segmentAt(0, 12_000, '')],
      words: wordsOf(text, { startMs: 0 }),
    });
    expect(cues.length).toBeGreaterThan(1);
    expectWithinRules(cues);
  });

  it('never makes a cue longer than 84 characters, broken into two lines', () => {
    const text = Array.from({ length: 40 }, () => 'palavra').join(' ');
    const cues = cuesOf({
      segments: [segmentAt(0, 6_000, '')],
      words: wordsOf(text, { startMs: 0, stepMs: 100, lengthMs: 90 }),
    });
    expectWithinRules(cues);
    expect(cues[0]?.text).toContain('\n');
  });

  it('uses the segment times when a segment has no words, split to the limits', () => {
    const text = Array.from({ length: 30 }, () => 'cantado').join(' ');
    const cues = cuesOf({
      segments: [
        segmentAt(0, 1_000, 'Antes.'),
        segmentAt(10_000, 30_000, text),
        segmentAt(31_000, 32_000, 'Depois.'),
      ],
      words: [
        ...wordsOf('Antes.', { startMs: 0, segment: 0 }),
        ...wordsOf('Depois.', { startMs: 31_000, segment: 2 }),
      ],
    });
    expect(cues[0]?.text).toBe('Antes.');
    expect(cues.at(-1)?.text).toBe('Depois.');
    const sung = cues.slice(1, -1);
    expect(sung[0]?.startMs).toBe(10_000);
    expect(sung.length).toBeGreaterThanOrEqual(4);
    expect(sung.map(flat).join(' ')).toBe(text);
    expectWithinRules(cues);
  });

  it('cuts a single word longer than a whole cue', () => {
    const word = 'a'.repeat(100);
    const cues = cuesOf({
      segments: [segmentAt(0, 2_000, word)],
      words: [],
    });
    expect(cues.map((cue) => cue.text.replace('\n', ''))).toEqual([
      'a'.repeat(84),
      'a'.repeat(16),
    ]);
  });

  it('keeps cues from running into the next one', () => {
    const words: DerivedWord[] = [
      { segment: 0, startMs: 0, endMs: 900, text: 'Um.', probability: 1 },
      { segment: 0, startMs: 700, endMs: 1_000, text: 'Dois.', probability: 1 },
    ];
    const cues = cuesOf({ segments: [segmentAt(0, 1_000, '')], words });
    expect(cues[0]?.endMs).toBe(700);
  });

  it('gives no cue for an empty transcript', () => {
    expect(cuesOf({ segments: [], words: [] })).toEqual([]);
    expect(cuesOf({ segments: [segmentAt(0, 1, '  ')], words: [] })).toEqual(
      [],
    );
  });
});

describe('linesOf', () => {
  it('keeps a short text on one line and splits a long one near the middle', () => {
    expect(linesOf('curto')).toBe('curto');
    const long =
      'Existia um rei denominado Inca e este rei tinha uma conselheira';
    const [first, second] = linesOf(long).split('\n');
    expect(first?.length).toBeLessThanOrEqual(42);
    expect(second?.length).toBeLessThanOrEqual(42);
    expect(`${first} ${second}`).toBe(long);
  });

  it('leaves a text without spaces as it is', () => {
    expect(linesOf('x'.repeat(50))).toBe('x'.repeat(50));
  });
});

describe('formatWebVtt', () => {
  it('writes a WebVTT file with numbered cues and escaped text', () => {
    const vtt = formatWebVtt([
      { startMs: 0, endMs: 1_500, text: 'A & B <c>' },
      { startMs: 3_723_004, endMs: 3_725_000, text: 'linha 1\nlinha 2' },
    ]);
    expect(vtt).toBe(
      'WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.500\nA &amp; B &lt;c&gt;\n\n' +
        '2\n01:02:03.004 --> 01:02:05.000\nlinha 1\nlinha 2\n',
    );
  });

  it('writes only the header when there is no cue', () => {
    expect(formatWebVtt([])).toBe('WEBVTT\n');
  });

  it('formats times as hh:mm:ss.mmm, never negative', () => {
    expect(vttTime(-5)).toBe('00:00:00.000');
    expect(vttTime(61_001)).toBe('00:01:01.001');
  });
});
