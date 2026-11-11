import { z } from 'zod';
import { SLUG_MAX, authorSlugSchema, slugOf } from './slugs.js';

export { authorSlugSchema } from './slugs.js';

/**
 * The authors of a collection (KBC-049, ADR 0030): free names kept per top-level
 * collection, with at most one main author (the master of that tradition). A
 * sub-collection uses its parent's list.
 */

/**
 * Longest author name: no longer than its id may be, so two long names never become the
 * same author by being cut.
 */
export const AUTHOR_NAME_MAX = SLUG_MAX;

/**
 * A name as kept: one line, no control or format characters and no quotes or guillemets
 * (it goes into the AI's rules and into "Cadastrar «nome»"), inner spaces collapsed.
 */
export const authorNameSchema = z
  .string()
  .transform((name) => name.replace(/[ \t]+/g, ' ').trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(AUTHOR_NAME_MAX)
      .regex(/^[^\p{Cc}\p{Cf}"«»]+$/u, { error: 'invalid author name' }),
  );
export const authorSchema = z.object({
  slug: authorSlugSchema,
  name: z.string().min(1),
  /** The collection's main author: shown first and with ✦ (BR-2). */
  main: z.boolean(),
});
export type Author = z.infer<typeof authorSchema>;

/** GET /api/v1/topics/:topic/authors: by name, the main author included. */
export const authorListSchema = z.object({ items: z.array(authorSchema) });
export type AuthorList = z.infer<typeof authorListSchema>;

/** POST /api/v1/topics/:topic/authors: the id comes from the name (FR-1). */
export const authorCreateSchema = z.strictObject({ name: authorNameSchema });
export type AuthorCreate = z.infer<typeof authorCreateSchema>;

/** The author id a name becomes (empty when it has no letter or digit). */
export const authorSlugOf = (name: string): string => slugOf(name);
