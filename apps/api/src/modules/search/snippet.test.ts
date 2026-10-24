import { describe, expect, it } from 'vitest';
import { cleanSnippet } from './snippet.js';

const body =
  'A NATUREZA SÉTUPLA\n\nTodas as manifestações vibratórias compreendem a setuplicidade.\nO ser humano tem sete corpos.';

describe('cleanSnippet', () => {
  it('keeps body lines and strips QMD line numbers and hunk headers', () => {
    const raw =
      '58: @@ -57,3 @@ (56 before)\n59: Todas as manifestações vibratórias compreendem a setuplicidade.\n60: O ser humano tem sete corpos.';
    expect(cleanSnippet(raw, { body, summary: 'resumo' })).toBe(
      'Todas as manifestações vibratórias compreendem a setuplicidade. O ser humano tem sete corpos.',
    );
  });

  it('uses the summary when the snippet fell inside the frontmatter', () => {
    const raw =
      '11: @@ -10,4 @@\n12:     - document\n13: title: A  NATUREZA  SÉTUPLA\n14: type: source';
    expect(
      cleanSnippet(raw, {
        body,
        summary: 'A aula apresenta a natureza sétupla.',
      }),
    ).toBe('A aula apresenta a natureza sétupla.');
  });

  it('falls back to the start of the body without a summary', () => {
    expect(cleanSnippet('title: x', { body, summary: null })).toMatch(
      /^A NATUREZA SÉTUPLA Todas/,
    );
  });

  it('accepts a line cut with an ellipsis', () => {
    const raw = '5: O ser humano tem sete...';
    expect(cleanSnippet(raw, { body, summary: null })).toBe(
      'O ser humano tem sete...',
    );
  });

  it('truncates long snippets on a word boundary', () => {
    const longBody = 'palavra '.repeat(100);
    const result = cleanSnippet('x', { body: longBody, summary: null });
    expect(result.length).toBeLessThanOrEqual(321);
    expect(result.endsWith('…')).toBe(true);
  });
});
