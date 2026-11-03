import { z } from 'zod';

/** Longest slug segment: a collection's name part or an author's id. */
export const SLUG_MAX = 60;

/**
 * The slug a name becomes: no accents, lowercase, words joined by hyphens (KBC-048 BR-4,
 * KBC-049). Empty when the name has no letter or digit.
 */
export function slugOf(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
}

/** An author's id (KBC-049): one slug segment. */
export const authorSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, { error: 'invalid author slug' })
  .max(SLUG_MAX);
