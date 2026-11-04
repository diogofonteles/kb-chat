import { z } from 'zod';
import { authorSlugSchema } from './slugs.js';

/**
 * The speakers of a collection (KBC-065, ADR 0029 §2): the people named in its recordings,
 * kept per top-level collection as authors are, optionally linked to one of its authors.
 */

/** Longest speaker name (FR-1). */
export const SPEAKER_NAME_MAX = 120;

/** Two names with the same key are the same speaker: accents, case and spaces aside. */
export const speakerKeyOf = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * A name as kept: one line, no control or format characters and no quotes or guillemets
 * (it goes into "Cadastrar «nome»"), inner spaces collapsed, and something left once accents
 * are set aside: a name with no key could not be a speaker.
 */
export const speakerNameSchema = z
  .string()
  .transform((name) => name.replace(/[ \t]+/g, ' ').trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(SPEAKER_NAME_MAX)
      .regex(/^[^\p{Cc}\p{Cf}"«»]+$/u, { error: 'invalid speaker name' })
      .refine((name) => speakerKeyOf(name) !== '', {
        error: 'invalid speaker name',
      }),
  );

export const collectionSpeakerSchema = z.object({
  id: z.uuid(),
  /** The author's name when linked to one (BR-2); else its own. */
  name: z.string().min(1),
  authorSlug: authorSlugSchema.nullable(),
  /** Linked to the collection's main author: shown with ✦ (BR-2). */
  main: z.boolean(),
});
export type CollectionSpeaker = z.infer<typeof collectionSpeakerSchema>;

/** GET /api/v1/topics/:topic/speakers: by name; a sub-collection answers with its parent's. */
export const collectionSpeakerListSchema = z.object({
  items: z.array(collectionSpeakerSchema),
});
export type CollectionSpeakerList = z.infer<typeof collectionSpeakerListSchema>;

/** POST /api/v1/topics/:topic/speakers. */
export const collectionSpeakerCreateSchema = z.strictObject({
  name: speakerNameSchema,
  authorSlug: authorSlugSchema.nullable().optional(),
});
export type CollectionSpeakerCreate = z.infer<
  typeof collectionSpeakerCreateSchema
>;

/** PATCH /api/v1/topics/:topic/speakers/:id: renames; `authorSlug` also links or unlinks. */
export const collectionSpeakerUpdateSchema = z.strictObject({
  name: speakerNameSchema,
  authorSlug: authorSlugSchema.nullable().optional(),
});
export type CollectionSpeakerUpdate = z.infer<
  typeof collectionSpeakerUpdateSchema
>;
