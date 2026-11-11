import { EMPTY_FILTERS } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import type { MediaSegmentMatch } from '../../ports/media-search.js';
import {
  EXCERPT_MAX,
  excerptOf,
  MAX_TERMS,
  authorRuleOf,
  hasDocumentOnlyFilters,
  scoreOf,
  termsOf,
  toMediaHit,
  unmark,
} from './media-hits.js';

describe('termsOf', () => {
  it('keeps letters and digits, lowercase, without repeats or FTS5 syntax', () => {
    expect(termsOf('Tiuaco "Mariri" OR tiuaco* NEAR(x)')).toEqual([
      'tiuaco',
      'mariri',
      'or',
      'near',
      'x',
    ]);
  });

  it('drops function words unless the question has nothing else', () => {
    expect(termsOf('o que é a hoasca?')).toEqual(['hoasca']);
    expect(termsOf('o que é')).toEqual(['o', 'que', 'é']);
  });

  it('keeps accents for the index to fold and caps the number of words', () => {
    expect(termsOf('Hóasca')).toEqual(['hóasca']);
    const many = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');
    expect(termsOf(many)).toHaveLength(MAX_TERMS);
  });

  it('reads a decomposed accent (NFD, pasted text) as one word', () => {
    expect(termsOf('ho\u0301asca')).toEqual(['hóasca']);
  });

  it('has no words for punctuation only', () => {
    expect(termsOf('?!…')).toEqual([]);
  });
});

describe('authorRuleOf', () => {
  const mainOf = new Map([['udv', 'mestre-gabriel']]);

  it('means anyone with no choice or with both media groups', () => {
    expect(authorRuleOf([], mainOf)).toEqual({ kind: 'any' });
    expect(authorRuleOf(['mestre-laercio', 'outros-autores'], mainOf)).toEqual({
      kind: 'any',
    });
  });

  it('narrows to the main author or the others', () => {
    expect(authorRuleOf(['mestre-laercio', 'sintese'], mainOf)).toEqual({
      kind: 'main',
      mainOf,
    });
    expect(authorRuleOf(['outros-autores'], mainOf)).toEqual({
      kind: 'others',
      mainOf,
    });
  });

  it('leaves nothing for groups media never have', () => {
    expect(authorRuleOf(['sintese', 'nao-classificado'], mainOf)).toBeNull();
  });
});

describe('hasDocumentOnlyFilters', () => {
  it('is true for genre, depth or relevance and false for subject, authorship or sub-collection', () => {
    expect(hasDocumentOnlyFilters(EMPTY_FILTERS)).toBe(false);
    expect(
      hasDocumentOnlyFilters({
        ...EMPTY_FILTERS,
        authorships: ['outros-autores'],
        topics: ['udv/palestras'],
        concepts: ['Cabala'],
      }),
    ).toBe(false);
    expect(
      hasDocumentOnlyFilters({ ...EMPTY_FILTERS, genres: ['paper'] }),
    ).toBe(true);
    expect(hasDocumentOnlyFilters({ ...EMPTY_FILTERS, depths: [1] })).toBe(
      true,
    );
    expect(
      hasDocumentOnlyFilters({ ...EMPTY_FILTERS, concepts: ['ritmo'] }),
    ).toBe(false);
    expect(
      hasDocumentOnlyFilters({ ...EMPTY_FILTERS, relevances: ['core'] }),
    ).toBe(true);
  });
});

describe('unmark', () => {
  it('returns the plain text and the character ranges of each match', () => {
    expect(unmark('\u0002Tiuaco\u0003 é \u0002Mariri\u0003.')).toEqual({
      text: 'Tiuaco é Mariri.',
      highlights: [
        { start: 0, end: 6 },
        { start: 9, end: 15 },
      ],
    });
  });

  it('counts characters outside the BMP as the browser does (UTF-16)', () => {
    const { text, highlights } = unmark('🎵 \u0002hoasca\u0003');
    expect(text.slice(highlights[0]?.start, highlights[0]?.end)).toBe('hoasca');
  });

  it('ignores an unmatched or empty marker', () => {
    expect(unmark('a\u0003b\u0002\u0003c')).toEqual({
      text: 'abc',
      highlights: [],
    });
  });
});

describe('scoreOf', () => {
  it('maps bm25 to 0–1, better matches higher', () => {
    expect(scoreOf(0)).toBe(0);
    expect(scoreOf(-9)).toBeCloseTo(0.9);
    expect(scoreOf(-9)).toBeGreaterThan(scoreOf(-1));
  });
});

describe('toMediaHit', () => {
  const match: MediaSegmentMatch = {
    mediaId: '11111111-1111-4111-8111-111111111111',
    topic: 'udv/palestras',
    title: 'Palestra',
    author: 'mestre-gabriel',
    marked: '\u0002Hoasca\u0003',
    startMs: 495_000,
    endMs: 499_000,
    confidence: 'low',
    bm25: -1,
  };
  const authors = {
    mainOf: () => 'mestre-gabriel',
    authorOf: (_topic: string, slug: string) => ({
      slug,
      name: 'Mestre Gabriel',
      main: true,
    }),
  };

  it("puts the collection's main author in the main group, with the name", () => {
    expect(toMediaHit(match, authors)).toEqual({
      mediaId: match.mediaId,
      topic: 'udv/palestras',
      title: 'Palestra',
      authorship: 'mestre-laercio',
      author: { slug: 'mestre-gabriel', name: 'Mestre Gabriel', main: true },
      text: 'Hoasca',
      highlights: [{ start: 0, end: 6 }],
      startMs: 495_000,
      endMs: 499_000,
      confidence: 'low',
      score: 0.5,
      match: 'speech',
      subjects: [],
    });
  });

  it('puts another author or none in "Outros autores"', () => {
    expect(toMediaHit({ ...match, author: 'outro' }, authors).authorship).toBe(
      'outros-autores',
    );
    const anonymous = toMediaHit({ ...match, author: null }, authors);
    expect(anonymous.authorship).toBe('outros-autores');
    expect(anonymous.author).toBeNull();
  });
});

describe('excerptOf (KBC-096)', () => {
  const marked = (text: string, word: string) => {
    const start = text.indexOf(word);
    return { text, highlights: [{ start, end: start + word.length }] };
  };
  const cut = (excerpt: ReturnType<typeof excerptOf>) =>
    excerpt.highlights.map((one) => excerpt.text.slice(one.start, one.end));

  it('leaves a short passage whole', () => {
    const passage = marked('o padre Orlando chegou', 'Orlando');
    expect(excerptOf(passage)).toEqual(passage);
  });

  it('keeps the word found in a long passage, cut on whole words', () => {
    const before = 'antes '.repeat(100);
    const after = ' depois'.repeat(100);
    const excerpt = excerptOf(marked(`${before}Orlando${after}`, 'Orlando'));
    expect(excerpt.text.length).toBeLessThanOrEqual(EXCERPT_MAX + 2);
    expect(excerpt.text.startsWith('…antes')).toBe(true);
    expect(excerpt.text.endsWith('depois…')).toBe(true);
    expect(cut(excerpt)).toEqual(['Orlando']);
  });

  it('reaches a word at the very end, with nothing cut after it', () => {
    const excerpt = excerptOf(
      marked(`${'antes '.repeat(100)}Orlando`, 'Orlando'),
    );
    expect(excerpt.text.endsWith('Orlando')).toBe(true);
    expect(cut(excerpt)).toEqual(['Orlando']);
  });

  it('never passes the limit, nor loses the word, with no spaces around it', () => {
    const text = `${'x'.repeat(300)}Orlando${'y'.repeat(300)}`;
    const excerpt = excerptOf(marked(text, 'Orlando'));
    expect(excerpt.text.length).toBeLessThanOrEqual(EXCERPT_MAX + 2);
    expect(cut(excerpt)).toEqual(['Orlando']);
  });

  it('cuts a text with no spaces rather than overflow', () => {
    const excerpt = excerptOf(marked('x'.repeat(500), 'x'));
    expect(excerpt.text.length).toBeLessThanOrEqual(EXCERPT_MAX + 2);
  });
});
