import { z } from 'zod';
import { authorSlugSchema, slugOf } from './slugs.js';

export const topicSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/, {
    error: 'invalid topic slug',
  });

/** Longest name and description of a collection created on the screen (KBC-048). */
export const TOPIC_TITLE_MAX = 80;
export const TOPIC_DESCRIPTION_MAX = 280;

export const topicSchema = z.object({
  slug: topicSlugSchema,
  title: z.string(),
  documentCount: z.number().int().nonnegative(),
  /** The collection this one sits in (one level only, ADR 0028), or null. */
  parent: topicSlugSchema.nullable().default(null),
  description: z.string().default(''),
  /**
   * False for a parent shown only as the title of its group: the person sees one of its
   * sub-collections, not the parent itself (KBC-048 BR-3).
   */
  canOpen: z.boolean().default(true),
  /** The person may rename it: a master any, others what they created (KBC-048). */
  canRename: z.boolean().default(false),
  /** Its main author (KBC-049 BR-2); a sub-collection shows its parent's. */
  mainAuthor: z
    .object({ slug: authorSlugSchema, name: z.string() })
    .nullable()
    .default(null),
});
export type Topic = z.infer<typeof topicSchema>;

export const topicListSchema = z.object({
  items: z.array(topicSchema),
  /** Topic configured to open by default (KB_TOPIC), or null. */
  defaultSlug: topicSlugSchema.nullable(),
});
export type TopicList = z.infer<typeof topicListSchema>;

const topicTitleSchema = z.string().trim().min(1).max(TOPIC_TITLE_MAX);
const topicDescriptionSchema = z.string().trim().max(TOPIC_DESCRIPTION_MAX);

/** POST /api/v1/topics: a new collection, or a sub-collection inside `parent`. */
export const topicCreateSchema = z.strictObject({
  title: topicTitleSchema,
  description: topicDescriptionSchema.default(''),
  parent: topicSlugSchema.nullable().default(null),
});
export type TopicCreate = z.input<typeof topicCreateSchema>;

/**
 * PATCH /api/v1/topics/:slug: the name, the description and the main author (KBC-049, an
 * author of the collection or null); the slug never changes.
 */
export const topicUpdateSchema = z
  .strictObject({
    title: topicTitleSchema.optional(),
    description: topicDescriptionSchema.optional(),
    mainAuthor: authorSlugSchema.nullable().optional(),
  })
  .refine(
    (body) =>
      body.title !== undefined ||
      body.description !== undefined ||
      body.mainAuthor !== undefined,
    {
      error: 'nothing to change',
    },
  );
export type TopicUpdate = z.input<typeof topicUpdateSchema>;

/** The slug a collection's name becomes (KBC-048 BR-4); empty without a letter or digit. */
export const topicSlugOf = (title: string): string => slugOf(title);
