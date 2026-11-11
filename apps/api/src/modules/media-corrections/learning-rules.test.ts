import { describe, expect, it } from 'vitest';
import {
  applyRules,
  deriveRules,
  learnable,
  learnedTerms,
  type LearningSource,
  type Rule,
} from './learning-rules.js';
import type { PlacedWord } from './word-rewrite.js';

let next = 0;

/** A correction in force as the store gives it. */
const source = (
  change: {
    before: string;
    after: string;
    context?: [string, string];
    mediaId?: string;
    at?: string;
  },
  extra: Partial<LearningSource> = {},
): LearningSource => ({
  id: `c${next++}`,
  mediaId: change.mediaId ?? 'm1',
  mediaTitle: 'Palestra',
  startMs: 1000,
  before: change.before.split(' '),
  after: change.after,
  contextBefore: change.context?.[0] ?? '',
  contextAfter: change.context?.[1] ?? '',
  createdAt: change.at ?? '2026-11-09T10:00:00.000Z',
  authorName: 'Maria',
  ...extra,
});

/** One segment per line, a word every 400 ms, positions running on. */
function wordsOf(...lines: string[]): PlacedWord[] {
  let position = 0;
  return lines.flatMap((line, segment) =>
    line.split(' ').map((text) => {
      const at = position++;
      return {
        position: at,
        segment,
        startMs: at * 400,
        endMs: (at + 1) * 400,
        text,
      };
    }),
  );
}

const rulesOf = (
  sources: readonly LearningSource[],
  options: Parameters<typeof deriveRules>[1] = {},
) => deriveRules(sources, options);

/** The text after the rules ran, one string per segment. */
function applied(
  words: readonly PlacedWord[],
  rules: readonly Rule[],
  skip: ReadonlySet<number> = new Set(),
): string[] {
  const byPosition = new Map(words.map((word) => [word.position, word.text]));
  for (const change of applyRules(words, rules, skip))
    change.words.forEach((word, index) =>
      byPosition.set(word.position, change.texts[index] ?? ''),
    );
  const segments = new Map<number, string[]>();
  for (const word of words) {
    const text = byPosition.get(word.position) ?? '';
    if (text === '') continue;
    segments.set(word.segment, [...(segments.get(word.segment) ?? []), text]);
  }
  return [...segments.values()].map((texts) => texts.join(' '));
}

const MANTA = { before: 'a Manta', after: 'Atlântida' } as const;

describe('learnable (BR-1)', () => {
  it('learns a change of words or of case, never a deletion or punctuation only (AC-7)', () => {
    expect(learnable(source(MANTA))).toBe(true);
    expect(learnable(source({ before: 'tiuaco', after: 'Tiuaco' }))).toBe(true);
    expect(learnable(source({ before: 'obrigado', after: '' }))).toBe(false);
    expect(learnable(source({ before: 'Mariri', after: 'Mariri,' }))).toBe(
      false,
    );
    expect(learnable(source({ before: 'Mariri', after: '  ' }))).toBe(false);
  });
});

describe('deriveRules (BR-2 to BR-4, BR-8)', () => {
  it('keeps the span, the new text and one word of context on each side (AC-1)', () => {
    const [rule] = rulesOf([source({ ...MANTA, context: ['com', 'foi,'] })]);
    expect(rule).toMatchObject({
      before: 'a Manta',
      after: 'Atlântida',
      contextBefore: 'com',
      contextAfter: 'foi',
      corrections: 1,
      recordings: 1,
      state: 'on',
    });
    expect(rule?.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('does not learn from deletions and punctuation (AC-7)', () => {
    expect(
      rulesOf([
        source({ before: 'obrigado', after: '' }),
        source({ before: 'Mariri', after: 'Mariri,' }),
      ]),
    ).toEqual([]);
  });

  it('the same change in 3 contexts also becomes a rule in any context (AC-4)', () => {
    const tiuako = (context: [string, string]) =>
      source({ before: 'Tiuako', after: 'Tiuaco', context });
    const two = rulesOf([tiuako(['o', 'disse']), tiuako(['do', 'veio'])]);
    expect(two.some((rule) => rule.contextBefore === null)).toBe(false);
    const three = rulesOf([
      tiuako(['o', 'disse']),
      tiuako(['do', 'veio']),
      tiuako(['ao', 'que']),
    ]);
    expect(three.find((rule) => rule.contextBefore === null)).toMatchObject({
      before: 'Tiuako',
      after: 'Tiuaco',
      contextAfter: null,
      corrections: 3,
    });
  });

  it('a conflict goes to the one with more corrections; a tie applies none (AC-5)', () => {
    const at: [string, string] = ['com', 'foi'];
    const majority = rulesOf([
      source({ ...MANTA, context: at }),
      source({ ...MANTA, context: at }),
      source({ before: 'a Manta', after: 'Amanta', context: at }),
    ]);
    expect(majority.find((rule) => rule.after === 'Atlântida')?.state).toBe(
      'on',
    );
    expect(majority.find((rule) => rule.after === 'Amanta')).toMatchObject({
      state: 'conflict',
      conflictWith: 'Atlântida',
    });
    const tie = rulesOf([
      source({ ...MANTA, context: at }),
      source({ before: 'a Manta', after: 'Amanta', context: at }),
    ]);
    expect(tie.map((rule) => rule.state)).toEqual(['conflict', 'conflict']);
  });

  it('turns itself off when its undone replacements reach its corrections, unless a master turned it on (AC-9)', () => {
    const [rule] = rulesOf([source({ ...MANTA, context: ['com', 'foi'] })]);
    const id = rule?.id ?? '';
    const tallies = new Map([[id, { applied: 1, undone: 1 }]]);
    expect(
      rulesOf([source(MANTA, { contextBefore: 'com', contextAfter: 'foi' })], {
        tallies,
      })[0],
    ).toMatchObject({
      state: 'auto-off',
      enabled: false,
      applied: 1,
      undone: 1,
    });
    const switches = new Map([
      [`rule:${id}`, { enabled: true, authorName: 'Diogo', at: 'x' }],
    ]);
    expect(
      rulesOf([source(MANTA, { contextBefore: 'com', contextAfter: 'foi' })], {
        tallies,
        switches,
      })[0],
    ).toMatchObject({ state: 'on', enabled: true, switchedBy: 'Diogo' });
  });

  it('a master turns a rule off (AC-15)', () => {
    const [rule] = rulesOf([source(MANTA)]);
    const switches = new Map([
      [
        `rule:${rule?.id ?? ''}`,
        { enabled: false, authorName: 'Diogo', at: 'x' },
      ],
    ]);
    expect(rulesOf([source(MANTA)], { switches })[0]).toMatchObject({
      state: 'off',
      enabled: false,
      switchedBy: 'Diogo',
    });
  });
});

describe('ties between contexts (BR-4, QA F1)', () => {
  const rivals = () =>
    rulesOf([
      source({ ...MANTA, context: ['com', 'foi'] }),
      source({ before: 'a Manta', after: 'Amanta', context: ['com', 'veio'] }),
    ]);

  it('two rules that may meet on one occurrence with as many corrections are told to the master', () => {
    const rules = rivals();
    expect(
      rules.map((rule) => [rule.after, rule.state, rule.tiesWith]).sort(),
    ).toEqual([
      ['Amanta', 'on', 'Atlântida'],
      ['Atlântida', 'on', 'Amanta'],
    ]);
    expect(applied(wordsOf('com a Manta disse'), rules)).toEqual([
      'com a Manta disse',
    ]);
    expect(applied(wordsOf('um a Manta foi'), rules)).toEqual([
      'um Atlântida foi',
    ]);
  });

  it('QA F7: on as many corrections, the rule matching both sides beats one matching a side', () => {
    expect(applied(wordsOf('e com a Manta foi'), rivals())).toEqual([
      'e com Atlântida foi',
    ]);
    expect(applied(wordsOf('e com a Manta veio'), rivals())).toEqual([
      'e com Amanta veio',
    ]);
  });

  it('no tie when one has more corrections, or the rival is off', () => {
    const more = rulesOf([
      source({ ...MANTA, context: ['com', 'foi'] }),
      source({ ...MANTA, context: ['com', 'foi'] }),
      source({ before: 'a Manta', after: 'Amanta', context: ['com', 'veio'] }),
    ]);
    expect(more.map((rule) => rule.tiesWith)).toEqual([null, null]);
    const [first] = rivals();
    const switches = new Map([
      [`rule:${first?.id ?? ''}`, { enabled: false, authorName: 'D', at: 'x' }],
    ]);
    const off = rulesOf(
      [
        source({ ...MANTA, context: ['com', 'foi'] }),
        source({
          before: 'a Manta',
          after: 'Amanta',
          context: ['com', 'veio'],
        }),
      ],
      { switches },
    );
    expect(off.map((rule) => rule.tiesWith)).toEqual([null, null]);
  });

  it('a rule turned off by undos is out of its place: the rival is no longer in conflict', () => {
    const at: [string, string] = ['com', 'foi'];
    const [atlantida] = rulesOf([source({ ...MANTA, context: at })]);
    const tallies = new Map([[atlantida?.id ?? '', { applied: 1, undone: 1 }]]);
    const rules = rulesOf(
      [
        source({ ...MANTA, context: at }),
        source({ before: 'a Manta', after: 'Amanta', context: at }),
      ],
      { tallies },
    );
    expect(rules.find((rule) => rule.after === 'Amanta')?.state).toBe('on');
    expect(rules.find((rule) => rule.after === 'Atlântida')?.state).toBe(
      'auto-off',
    );
  });
});

describe('applyRules (BR-3 to BR-6)', () => {
  const rules = rulesOf([source({ ...MANTA, context: ['com', 'foi'] })]);

  it('replaces the span when one side of the context matches, and not elsewhere (AC-2)', () => {
    expect(
      applied(wordsOf('e com a Manta veio', 'na a Manta disse'), rules),
    ).toEqual(['e com Atlântida veio', 'na a Manta disse']);
    expect(applied(wordsOf('ela a manta foi'), rules)).toEqual([
      'ela Atlântida foi',
    ]);
  });

  it('keeps times and word count: the first word gets the text, the rest are emptied (BR-5)', () => {
    const words = wordsOf('e com a Manta veio');
    const [change] = applyRules(words, rules, new Set());
    expect(change?.words.map((word) => word.position)).toEqual([2, 3]);
    expect(change?.texts).toEqual(['Atlântida', '']);
    expect(change?.rule.id).toBe(rules[0]?.id);
  });

  it('keeps the occurrence edge punctuation and a leading capital (AC-6)', () => {
    const lower = rulesOf([
      source({
        before: 'concerteza',
        after: 'com certeza',
        context: ['', 'ele'],
      }),
    ]);
    expect(applied(wordsOf('Concerteza, ele veio'), lower)).toEqual([
      'Com certeza, ele veio',
    ]);
    expect(applied(wordsOf('com a Manta, foi'), rules)).toEqual([
      'com Atlântida, foi',
    ]);
  });

  it('a segment edge alone is no context: a real word must match (review round 1)', () => {
    const edge = rulesOf([source({ ...MANTA, context: ['', 'veio'] })]);
    expect(applied(wordsOf('a Manta disse'), edge)).toEqual(['a Manta disse']);
    expect(applied(wordsOf('a Manta veio'), edge)).toEqual(['Atlântida veio']);
    expect(applied(wordsOf('e a Manta veio'), edge)).toEqual([
      'e Atlântida veio',
    ]);
  });

  it('applies a rule in any context, and a contextual one wins over it (AC-4)', () => {
    const tiuako = (context: [string, string], after = 'Tiuaco') =>
      source({ before: 'Tiuako', after, context });
    const all = rulesOf([
      tiuako(['o', 'disse']),
      tiuako(['do', 'veio']),
      tiuako(['ao', 'que']),
      tiuako(['mestre', 'falou'], 'Tiwaco'),
    ]);
    expect(
      applied(wordsOf('um Tiuako novo', 'mestre Tiuako falou'), all),
    ).toEqual(['um Tiuaco novo', 'mestre Tiwaco falou']);
  });

  it('never touches words the carry-over wrote, nor a rule turned off (BR-6, BR-8)', () => {
    const words = wordsOf('e com a Manta veio');
    expect(applied(words, rules, new Set([3]))).toEqual(['e com a Manta veio']);
    const off = rules.map((rule) => ({ ...rule, enabled: false }));
    expect(applied(words, off)).toEqual(['e com a Manta veio']);
  });

  it('a tie applies none (AC-5)', () => {
    const tie = rulesOf([
      source({ ...MANTA, context: ['com', 'foi'] }),
      source({ before: 'a Manta', after: 'Amanta', context: ['com', 'foi'] }),
    ]);
    expect(applied(wordsOf('com a Manta foi'), tie)).toEqual([
      'com a Manta foi',
    ]);
  });

  it('skips an occurrence that already says the new text', () => {
    const fixCase = rulesOf([
      source({ before: 'tiuaco', after: 'Tiuaco', context: ['o', 'disse'] }),
    ]);
    expect(applyRules(wordsOf('o Tiuaco disse'), fixCase, new Set())).toEqual(
      [],
    );
    expect(applied(wordsOf('o tiuaco disse'), fixCase)).toEqual([
      'o Tiuaco disse',
    ]);
  });
});

describe('learnedTerms (BR-9)', () => {
  const tokens = (list: readonly string[]) =>
    list.reduce((sum, term) => sum + term.split(' ').length * 2, 0);
  const fitsIn =
    (limit: number) =>
    (list: readonly string[]): boolean =>
      tokens(list) <= limit;

  it('takes names and terms corrected twice, most corrected first, not the masters ones (AC-11, AC-13)', () => {
    const terms = learnedTerms(
      [
        source({ before: 'Tiuako', after: 'Tiuaco' }),
        source({ before: 'Atlantida', after: 'Atlântida' }),
        source({ before: 'Atlantida', after: 'Atlântida,' }, { mediaId: 'm2' }),
        source({ before: 'concerteza', after: 'com certeza' }),
        source({ before: 'Mariri', after: 'Mariri' }),
        source({ before: 'mestre', after: 'Mestre Gabriel' }),
      ],
      { manual: ['mestre gabriel'], fits: fitsIn(100) },
    );
    expect(
      terms.map((term) => [term.term, term.corrections, term.state]),
    ).toEqual([
      ['Atlântida', 2, 'in-list'],
      ['Tiuaco', 1, 'in-list'],
    ]);
    expect(terms[0]?.recordings).toBe(2);
  });

  it('a lower-case text corrected twice is a term (AC-13)', () => {
    const terms = learnedTerms(
      [
        source({ before: 'mariri', after: 'mariri,' }),
        source({ before: 'marir', after: 'mariri' }),
        source({ before: 'mari ri', after: 'mariri' }),
      ],
      { manual: [], fits: fitsIn(100) },
    );
    expect(terms.map((term) => term.term)).toEqual(['mariri']);
  });

  it('what does not fit is left out, and an off term is never sent (AC-12, AC-15)', () => {
    const many = [
      source({ before: 'A', after: 'Alfa' }),
      source({ before: 'A', after: 'Alfa' }),
      source({ before: 'B', after: 'Beta Gama' }),
      source({ before: 'D', after: 'Delta' }),
    ];
    const first = learnedTerms(many, { manual: ['x'], fits: fitsIn(6) });
    expect(first.map((term) => [term.term, term.state])).toEqual([
      ['Alfa', 'in-list'],
      ['Beta Gama', 'no-room'],
      ['Delta', 'in-list'],
    ]);
    const off = first.find((term) => term.term === 'Alfa')?.id ?? '';
    const switches = new Map([
      [`term:${off}`, { enabled: false, authorName: 'Diogo', at: 'x' }],
    ]);
    const second = learnedTerms(many, {
      manual: ['x'],
      fits: fitsIn(6),
      switches,
    });
    expect(second.map((term) => [term.term, term.state])).toEqual([
      ['Alfa', 'off'],
      ['Beta Gama', 'in-list'],
      ['Delta', 'no-room'],
    ]);
  });

  it('refuses what cannot be a term: a comma inside, more than 3 words', () => {
    expect(
      learnedTerms(
        [
          source({ before: 'x', after: 'Um, Dois' }),
          source({ before: 'y', after: 'Um Dois Três Quatro' }),
        ],
        { manual: [], fits: fitsIn(100) },
      ),
    ).toEqual([]);
  });
});
