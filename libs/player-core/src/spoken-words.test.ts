import { describe, expect, it } from 'vitest';
import { lastStartedAt } from './cues.js';
import { alignWords, wordAtOffset } from './spoken-words.js';

const timed = (text: string, startMs: number, endMs = startMs + 100) => ({
  text,
  startMs,
  endMs,
});

const LINE = 'o que está em cima';
const WORDS = [
  timed('o', 0),
  timed('que', 300),
  timed('está', 600),
  timed('em', 900),
  timed('cima', 1_200),
];

describe('alignWords (KBC-045)', () => {
  it('finds each word in the text of its segment', () => {
    const aligned = alignWords(LINE, WORDS);
    expect(
      aligned.map((word) => LINE.slice(word.charStart, word.charEnd)),
    ).toEqual(['o', 'que', 'está', 'em', 'cima']);
  });

  it('keeps the punctuation whisper glued to a word', () => {
    const text = 'Sim, é verdade.';
    const aligned = alignWords(text, [
      timed('Sim,', 0),
      timed('é', 300),
      timed('verdade.', 600),
    ]);
    expect(aligned[2]).toMatchObject({ charStart: 7, charEnd: 15 });
  });

  it('tells apart a word repeated in the same segment', () => {
    const aligned = alignWords('a casa a casa', [
      timed('a', 0),
      timed('casa', 100),
      timed('a', 200),
      timed('casa', 300),
    ]);
    expect(aligned.map((word) => word.charStart)).toEqual([0, 2, 7, 9]);
  });

  it('gives no words when one is not in the text: the segment highlight stands in', () => {
    expect(alignWords(LINE, [timed('o', 0), timed('fora', 300)])).toEqual([]);
  });

  it('gives no words to a segment without any (AC-4)', () => {
    expect(alignWords(LINE, [])).toEqual([]);
  });

  it('skips a word with no text', () => {
    const aligned = alignWords('sim não', [
      timed('sim', 0),
      timed('', 100),
      timed('não', 200),
    ]);
    expect(aligned).toHaveLength(2);
  });

  it('keeps the starts in order, as the binary search needs', () => {
    const aligned = alignWords('um dois três', [
      timed('um', 500),
      timed('dois', 400),
      timed('três', 900),
    ]);
    expect(aligned.map((word) => word.startMs)).toEqual([500, 500, 900]);
  });
});

describe('the word at a time (KBC-045 BR-1, AC-1)', () => {
  const aligned = alignWords(LINE, WORDS);

  it('is the word started, between the start of "está" and that of "em"', () => {
    expect(lastStartedAt(aligned, 600)).toBe(2);
    expect(lastStartedAt(aligned, 899)).toBe(2);
    expect(lastStartedAt(aligned, 900)).toBe(3);
  });

  it('stays on the previous word through a silence', () => {
    expect(lastStartedAt(aligned, 750)).toBe(2);
  });

  it('is none before the first word starts', () => {
    expect(lastStartedAt(alignWords('fala', [timed('fala', 500)]), 499)).toBe(
      -1,
    );
  });
});

describe('wordAtOffset (KBC-045 FR-3)', () => {
  const aligned = alignWords(LINE, WORDS);

  it('finds the word under a character', () => {
    expect(wordAtOffset(aligned, 15)?.startMs).toBe(1_200);
  });

  it('takes the word before a space, and the first for its own start', () => {
    expect(wordAtOffset(aligned, 5)?.startMs).toBe(300);
    expect(wordAtOffset(aligned, 0)?.startMs).toBe(0);
  });

  it('is nothing in a segment without words', () => {
    expect(wordAtOffset([], 3)).toBeNull();
  });
});
