import { describe, expect, it } from 'vitest';
import {
  alignSegment,
  carryKey,
  carryOver,
  findRuns,
  isContiguous,
  occurrenceKey,
  occurrenceReplacement,
  replacedTexts,
  rewriteSegment,
  tidyText,
  type PlacedWord,
} from './word-rewrite.js';

/** Words of one segment from a line, one every 400 ms, positions from `from`. */
const wordsOf = (line: string, segment = 0, from = 0): PlacedWord[] =>
  line.split(' ').map((text, index) => ({
    position: from + index,
    segment,
    startMs: (from + index) * 400,
    endMs: (from + index + 1) * 400,
    text,
  }));

const rewrite = (
  text: string,
  change: { position: number; count: number; replacement: string },
  words = wordsOf(text),
) => rewriteSegment({ text, words, ...change });

describe('tidyText (BR-3)', () => {
  it('trims the ends and keeps one space inside, as typed otherwise (AC-7)', () => {
    expect(tidyText('  Tiuaco  ,')).toEqual({ ok: true, text: 'Tiuaco ,' });
    expect(tidyText('Tiuaco,')).toEqual({ ok: true, text: 'Tiuaco,' });
    expect(tidyText('')).toEqual({ ok: true, text: '' });
  });

  it('refuses a line break or more than 80 characters (AC-8)', () => {
    expect(tidyText('a\nb')).toEqual({ ok: false });
    expect(tidyText('x'.repeat(81))).toEqual({ ok: false });
    expect(tidyText(` ${'x'.repeat(80)} `)).toEqual({
      ok: true,
      text: 'x'.repeat(80),
    });
  });
});

describe('rewriteSegment (ADR 0034 §1)', () => {
  it('replaces one word and keeps its neighbours (AC-1)', () => {
    expect(
      rewrite('O mestre Tiuako disse', {
        position: 2,
        count: 1,
        replacement: 'Tiuaco',
      }),
    ).toBe('O mestre Tiuaco disse');
  });

  it('joins two words into one text, the second left empty (AC-4)', () => {
    expect(
      rewrite('é con certeza assim', {
        position: 1,
        count: 2,
        replacement: 'com certeza',
      }),
    ).toBe('é com certeza assim');
    expect(replacedTexts(2, 'com certeza')).toEqual(['com certeza', '']);
  });

  it('splits one word into two by a space (AC-5)', () => {
    expect(
      rewrite('foi concerteza.', {
        position: 1,
        count: 1,
        replacement: 'com certeza.',
      }),
    ).toBe('foi com certeza.');
  });

  it('removes a word with one space, at the start, middle or end (AC-9)', () => {
    const line = 'obrigado eu disse obrigado';
    expect(rewrite(line, { position: 0, count: 1, replacement: '' })).toBe(
      'eu disse obrigado',
    );
    expect(rewrite(line, { position: 1, count: 1, replacement: '' })).toBe(
      'obrigado disse obrigado',
    );
    expect(rewrite(line, { position: 3, count: 1, replacement: '' })).toBe(
      'obrigado eu disse',
    );
  });

  it('puts a removed word back after the word before it, or first (AC-9 undo)', () => {
    const words = wordsOf('eu obrigado disse').map((word) =>
      word.position === 1 ? { ...word, text: '' } : word,
    );
    expect(
      rewrite(
        'eu disse',
        { position: 1, count: 1, replacement: 'obrigado' },
        words,
      ),
    ).toBe('eu obrigado disse');
    const first = wordsOf('obrigado eu').map((word) =>
      word.position === 0 ? { ...word, text: '' } : word,
    );
    expect(
      rewrite('eu', { position: 0, count: 1, replacement: 'obrigado' }, first),
    ).toBe('obrigado eu');
  });

  it('keeps a word glued to the one before it glued', () => {
    const words = [
      { position: 0, text: 'd' },
      { position: 1, text: "'água" },
    ];
    expect(
      rewriteSegment({
        text: "d'água boa",
        words,
        position: 1,
        count: 1,
        replacement: "'Água",
      }),
    ).toBe("d'Água boa");
  });

  it('answers null when the words do not align with the text', () => {
    expect(
      rewrite(
        'outra coisa',
        { position: 0, count: 1, replacement: 'x' },
        wordsOf('nada disso'),
      ),
    ).toBeNull();
    expect(alignSegment('a b', wordsOf('a c'))).toBeNull();
  });
});

describe('isContiguous (AC-6)', () => {
  const words = [...wordsOf('a b', 0, 0), ...wordsOf('c d', 1, 2)];
  it('accepts consecutive words of one segment, up to five', () => {
    expect(isContiguous(words.slice(0, 2), 2)).toBe(true);
    expect(isContiguous(wordsOf('a b c d e f'), 6)).toBe(false);
  });
  it('refuses words of two segments, a gap or a missing word', () => {
    expect(isContiguous(words.slice(1, 3), 2)).toBe(false);
    expect(isContiguous([words[0], words[2]] as PlacedWord[], 2)).toBe(false);
    expect(isContiguous(words.slice(0, 1), 2)).toBe(false);
    expect(isContiguous([], 1)).toBe(false);
  });
});

describe('occurrences (BR-11, AC-31)', () => {
  it('compares without case and edge punctuation, and keeps each one its punctuation', () => {
    expect(occurrenceKey('  Tiuako, ')).toBe('tiuako');
    expect(occurrenceReplacement('Tiuako,', 'Tiuaco')).toBe('Tiuaco,');
    expect(occurrenceReplacement('tiuako.', 'Tiuaco')).toBe('Tiuaco.');
    expect(occurrenceReplacement('(tiuako)', 'Tiuaco!')).toBe('(Tiuaco)');
  });

  it('finds runs of one segment, multi-word, never across segments', () => {
    const words = [
      ...wordsOf('Tiuako, disse con certeza', 0, 0),
      ...wordsOf('e tiuako. con', 1, 4),
      ...wordsOf('certeza fim', 2, 7),
    ];
    expect(findRuns(words, 'tiuako').map((run) => run.said)).toEqual([
      'Tiuako,',
      'tiuako.',
    ]);
    const pairs = findRuns(words, 'con certeza');
    expect(pairs.map((run) => run.words.map((word) => word.position))).toEqual([
      [2, 3],
    ]);
  });

  it('counts an empty word inside a run and ignores runs longer than five', () => {
    const words = wordsOf('con x certeza').map((word) =>
      word.position === 1 ? { ...word, text: '' } : word,
    );
    expect(
      findRuns(words, 'con certeza').map((run) => run.words.length),
    ).toEqual([3]);
    expect(findRuns(words, 'a b c d e f')).toEqual([]);
    expect(findRuns(words, ' , ')).toEqual([]);
  });

  it('does not overlap runs', () => {
    expect(findRuns(wordsOf('a a a'), 'a a')).toHaveLength(1);
  });
});

describe('carryOver (BR-9, AC-19)', () => {
  const correction = {
    startMs: 800,
    endMs: 1_200,
    count: 1,
    before: ['Tiuako'],
    after: 'Tiuaco',
  };

  it('lands where the same words, by time and text, are on the new version', () => {
    const outcome = carryOver(correction, wordsOf('o mestre tiuáko! disse'));
    expect(outcome).toEqual({
      carried: true,
      words: [expect.objectContaining({ position: 2 })],
    });
    expect(carryKey('Tiuáko!')).toBe('tiuako');
  });

  it('says what the new version has there otherwise', () => {
    expect(carryOver(correction, wordsOf('o mestre Mareri disse'))).toEqual({
      carried: false,
      found: 'Mareri',
    });
    expect(
      carryOver({ ...correction, count: 2 }, wordsOf('o mestre Tiuako disse')),
    ).toEqual({ carried: false, found: 'Tiuako' });
  });
});
