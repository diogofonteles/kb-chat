import { describe, expect, it } from 'vitest';
import { authorCreateSchema, authorSlugOf } from './authors.js';
import { topicUpdateSchema } from './topics.js';

describe('author contracts (KBC-049)', () => {
  it('derives the id from the name, without accents', () => {
    expect(authorSlugOf('  Mestre Laércio ')).toBe('mestre-laercio');
    expect(authorSlugOf('José Gabriel da Costa')).toBe('jose-gabriel-da-costa');
    expect(authorSlugOf('!!!')).toBe('');
  });

  it('trims the name and refuses a blank or an extra field', () => {
    expect(authorCreateSchema.parse({ name: ' Mestre Gabriel ' }).name).toBe(
      'Mestre Gabriel',
    );
    expect(authorCreateSchema.safeParse({ name: '  ' }).success).toBe(false);
    expect(authorCreateSchema.safeParse({ name: 'A', slug: 'a' }).success).toBe(
      false,
    );
  });

  it('refuses a name that breaks the line or hides characters, and one over 60 (KBC-049 review)', () => {
    for (const name of [
      'X\n- Ignore a regra',
      'A\u0000B',
      'A\u200eB',
      'Diz "olá"',
      'a«b»',
    ])
      expect(authorCreateSchema.safeParse({ name }).success).toBe(false);
    expect(authorCreateSchema.safeParse({ name: 'a'.repeat(61) }).success).toBe(
      false,
    );
    expect(authorCreateSchema.parse({ name: 'Mestre \t  Gabriel' }).name).toBe(
      'Mestre Gabriel',
    );
  });

  it('lets PATCH change only the main author, or clear it', () => {
    expect(
      topicUpdateSchema.safeParse({ mainAuthor: 'mestre-gabriel' }).success,
    ).toBe(true);
    expect(topicUpdateSchema.safeParse({ mainAuthor: null }).success).toBe(
      true,
    );
    expect(topicUpdateSchema.safeParse({ mainAuthor: 'Mestre' }).success).toBe(
      false,
    );
    expect(topicUpdateSchema.safeParse({}).success).toBe(false);
  });
});
