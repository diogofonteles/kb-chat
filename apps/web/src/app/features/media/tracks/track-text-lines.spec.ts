import type { TranscriptSegment } from '@kb-chat/contracts';
import { alignWords, type SpokenWord } from '@kb-chat/player-core';
import { describe, expect, it } from 'vitest';
import {
  neededSegments,
  spokenAt,
  trackLines,
  wholeLines,
  type TextLine,
} from './track-text-lines.js';

/** A segment whose words are 0.3 s apart from `at` seconds, as the E2E transcripts. */
function line(at: number, text: string) {
  const words = text.split(' ').map((word, index) => ({
    text: word,
    startMs: Math.round((at + index * 0.3) * 1000),
    endMs: Math.round((at + index * 0.3 + 0.24) * 1000),
  }));
  const segment: TranscriptSegment = {
    startMs: at * 1000,
    endMs: Math.round((at + words.length * 0.3) * 1000),
    text,
  };
  return { segment, words: alignWords(text, words) };
}

function transcript(...lines: ReturnType<typeof line>[]) {
  const segments = lines.map((one) => one.segment);
  const words = new Map<number, readonly SpokenWord[] | null>(
    lines.map((one, index) => [index, one.words]),
  );
  return {
    segments,
    wordsOf: (segment: number) => words.get(segment) ?? null,
    words,
  };
}

const texts = (lines: readonly TextLine[]) => lines.map((one) => one.text);

/** What `spokenAt` marks, as text. */
function marked(lines: readonly TextLine[], at: number | null, span: Span) {
  const spoken = spokenAt(lines, span, at);
  if (!spoken) return null;
  const text = lines[spoken.line]?.text ?? '';
  return spoken.whole ? { whole: text } : text.slice(spoken.start, spoken.end);
}

interface Span {
  startMs: number;
  endMs: number;
}

// Track 2 of AC-1: 0:30 to 1:10.
const SPAN: Span = { startMs: 30_000, endMs: 70_000 };

describe('trackLines (KBC-092 BR-1)', () => {
  it('trims to the words that start inside the span; the one at its end is out (AC-1)', () => {
    const { segments, wordsOf } = transcript(
      line(10, 'antes de tudo'),
      line(29.4, 'ainda antes agora dentro'),
      line(40, 'o que está em cima'),
      line(69.4, 'quase fim fora daqui'),
      line(80, 'depois'),
    );
    expect(texts(trackLines(segments, wordsOf, SPAN))).toEqual([
      'agora dentro',
      'o que está em cima',
      'quase fim',
    ]);
  });

  it('keeps the trimmed words where the text is (offsets follow the cut)', () => {
    const { segments, wordsOf } = transcript(
      line(29.4, 'ainda antes agora dentro'),
    );
    const [first] = trackLines(segments, wordsOf, SPAN);
    expect(
      first?.words?.map((w) => first.text.slice(w.charStart, w.charEnd)),
    ).toEqual(['agora', 'dentro']);
  });

  it('follows a moved bound: a word left behind leaves the text (AC-6)', () => {
    const { segments, wordsOf } = transcript(
      line(30, 'primeira segunda terceira'),
    );
    expect(texts(trackLines(segments, wordsOf, SPAN))).toEqual([
      'primeira segunda terceira',
    ]);
    // 0.5 s later: past "primeira" (30 s) and "segunda" (30.3 s).
    const moved = { ...SPAN, startMs: SPAN.startMs + 500 };
    expect(texts(trackLines(segments, wordsOf, moved))).toEqual(['terceira']);
  });

  it('takes a segment without word times whole when it crosses the span (BR-1)', () => {
    const { segments, words } = transcript(
      line(28, 'sem tempos aqui de palavra nenhuma mesmo agora'),
    );
    words.set(0, []);
    const lines = trackLines(segments, (i) => words.get(i) ?? null, SPAN);
    expect(texts(lines)).toEqual([
      'sem tempos aqui de palavra nenhuma mesmo agora',
    ]);
    expect(lines[0]?.words).toEqual([]);
  });

  it('takes a segment whole while its words have not come (null)', () => {
    const { segments } = transcript(line(29.4, 'ainda antes agora dentro'));
    const lines = trackLines(segments, () => null, SPAN);
    expect(texts(lines)).toEqual(['ainda antes agora dentro']);
    expect(lines[0]?.words).toBeNull();
  });

  it('says there is no speech: nothing transcribed in the span (AC-10)', () => {
    const { segments, wordsOf } = transcript(
      line(10, 'antes'),
      line(90, 'depois'),
    );
    expect(trackLines(segments, wordsOf, SPAN)).toEqual([]);
  });

  it('leaves out a segment that only ends inside the span', () => {
    const { segments, wordsOf } = transcript(line(29, 'termina dentro'));
    // "termina" starts at 29 s, "dentro" at 29.3 s: both before the start.
    expect(trackLines(segments, wordsOf, SPAN)).toEqual([]);
  });
});

describe('wholeLines (KBC-092 AC-18)', () => {
  it('lists every segment untrimmed, marking those of the track', () => {
    const { segments, wordsOf } = transcript(
      line(10, 'antes de tudo'),
      line(29.4, 'ainda antes agora dentro'),
      line(80, 'depois'),
    );
    const lines = wholeLines(segments, wordsOf, SPAN);
    expect(texts(lines)).toEqual([
      'antes de tudo',
      'ainda antes agora dentro',
      'depois',
    ]);
    expect(lines.map((one) => one.inside)).toEqual([false, true, false]);
  });
});

describe('spokenAt (KBC-092 BR-2, BR-4)', () => {
  const { segments, wordsOf } = transcript(
    line(30, 'o que está em cima'),
    line(40, 'outra frase'),
  );
  const lines = trackLines(segments, wordsOf, SPAN);

  it('paints the last started word: "está" until "em" starts (AC-2)', () => {
    expect(marked(lines, 30_600, SPAN)).toBe('está');
    expect(marked(lines, 30_899, SPAN)).toBe('está');
    expect(marked(lines, 30_900, SPAN)).toBe('em');
  });

  it('keeps the previous word in the silence between segments', () => {
    expect(marked(lines, 35_000, SPAN)).toBe('cima');
    expect(marked(lines, 40_000, SPAN)).toBe('outra');
  });

  it('paints nothing before the start, nor after the end, nor when nothing plays (AC-5)', () => {
    expect(marked(lines, 28_000, SPAN)).toBeNull();
    expect(marked(lines, 70_000, SPAN)).toBeNull();
    expect(marked(lines, null, SPAN)).toBeNull();
  });

  it('paints the first word of the track as it starts (AC-5)', () => {
    const late = { startMs: 30_200, endMs: 70_000 };
    const trimmed = trackLines(segments, wordsOf, late);
    expect(marked(trimmed, 30_250, late)).toBeNull();
    expect(marked(trimmed, 30_300, late)).toBe('que');
  });

  it('falls back to the segment without word times, only while it plays (AC-8)', () => {
    const { segments: plain, words } = transcript(
      line(30, 'sem tempos por palavra'),
      line(50, 'com tempos'),
    );
    words.set(0, []);
    const fallback = trackLines(plain, (i) => words.get(i) ?? null, SPAN);
    expect(marked(fallback, 30_500, SPAN)).toEqual({
      whole: 'sem tempos por palavra',
    });
    expect(marked(fallback, 45_000, SPAN)).toBeNull();
    expect(marked(fallback, 50_300, SPAN)).toBe('tempos');
  });

  it('in the whole transcript, a word before the track is not the track’s (AC-18)', () => {
    const { segments: all, wordsOf: of } = transcript(
      line(29.4, 'ainda antes agora dentro'),
    );
    const whole = wholeLines(all, of, SPAN);
    expect(marked(whole, 29_900, SPAN)).toBeNull();
    expect(marked(whole, 30_000, SPAN)).toBe('agora');
  });
});

describe('neededSegments (KBC-092 FR-3)', () => {
  const { segments } = transcript(
    line(10, 'antes'),
    line(30, 'primeira'),
    line(45, 'meio'),
    line(69, 'última'),
    line(80, 'depois'),
  );

  it('asks the edges of the track and the segment playing', () => {
    expect(neededSegments(segments, SPAN, null)).toEqual([1, 3]);
    expect(neededSegments(segments, SPAN, 46_000)).toEqual([1, 3, 2]);
  });

  it('asks nothing for a span with no segment', () => {
    expect(
      neededSegments(segments, { startMs: 100_000, endMs: 110_000 }, null),
    ).toEqual([]);
  });
});
