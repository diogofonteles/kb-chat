import { describe, expect, it } from 'vitest';
import { topicCreateSchema, topicSlugOf, topicUpdateSchema } from './topics.js';

describe('topicSlugOf (KBC-048 BR-4)', () => {
  it.each([
    ['UDV', 'udv'],
    ['Palavra do Mestre', 'palavra-do-mestre'],
    ['União do Vegetal', 'uniao-do-vegetal'],
    ['  Ação & Reação!  ', 'acao-reacao'],
    ['!!!', ''],
  ])('%s → %s', (title, slug) => {
    expect(topicSlugOf(title)).toBe(slug);
  });

  it('keeps at most 60 characters and never ends on a hyphen', () => {
    const slug = topicSlugOf(`${'a'.repeat(59)} b`);
    expect(slug).toBe('a'.repeat(59));
  });
});

describe('topic create and update bodies', () => {
  it('trims the name and defaults the rest', () => {
    expect(topicCreateSchema.parse({ title: '  UDV ' })).toEqual({
      title: 'UDV',
      description: '',
      parent: null,
    });
  });

  it('refuses an empty name, unknown fields and an empty update', () => {
    expect(topicCreateSchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(topicCreateSchema.safeParse({ title: 'X', slug: 'y' }).success).toBe(
      false,
    );
    expect(topicUpdateSchema.safeParse({}).success).toBe(false);
  });
});
