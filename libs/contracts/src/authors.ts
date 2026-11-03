import { z } from 'zod';
import { topicSlugOf } from './topics.js';

/**
 * The authors of a collection (KBC-049, ADR 0030): free names kept per top-level
 * collection, with at most one main author (the master of that tradition). A
 * sub-collection uses its parent's list.
 */

/** Longest author name. */
export const AUTHOR_NAME_MAX = 120;

/** An author's id: the name without accents, lowercase, words joined by hyphens. */
export const authorSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, { error: 'invalid author slug' })
  .max(60);

export const authorSchema = z.object({
  slug: authorSlugSchema,
  name: z.string().min(1).max(AUTHOR_NAME_MAX),
  /** The collection's main author: shown first and with ✦ (BR-2). */
  main: z.boolean(),
});
export type Author = z.infer<typeof authorSchema>;

/** GET /api/v1/topics/:topic/authors: by name, the main author included. */
export const authorListSchema = z.object({ items: z.array(authorSchema) });
export type AuthorList = z.infer<typeof authorListSchema>;

/** POST /api/v1/topics/:topic/authors: the id comes from the name (FR-1). */
export const authorCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(AUTHOR_NAME_MAX),
});
export type AuthorCreate = z.infer<typeof authorCreateSchema>;

/** The author id a name becomes (empty when it has no letter or digit). */
export const authorSlugOf = (name: string): string => topicSlugOf(name);
