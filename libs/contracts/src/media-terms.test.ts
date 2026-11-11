import { describe, expect, it } from 'vitest';
import { normalizeTerms, termSchema } from './media-terms.js';

describe('normalizeTerms', () => {
  it('tidies spaces, drops empty lines and keeps the first of a repeated term', () => {
    expect(
      normalizeTerms(['  Rei   Salomão ', '', 'tiuaco', 'Tiuaco', '   ']),
    ).toEqual(['Rei Salomão', 'tiuaco']);
  });
});

describe('termSchema', () => {
  it.each(['a,b', '<|endoftext|>', 'a|b', 'a\nb', '', 'x'.repeat(101)])(
    'refuses %j',
    (term) => {
      expect(termSchema.safeParse(term).success).toBe(false);
    },
  );

  it('accepts a name with an accent, an apostrophe and a hyphen', () => {
    expect(termSchema.safeParse("São João d'Aliança-GO").success).toBe(true);
  });
});
