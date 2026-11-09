import { z } from 'zod';
import { documentFacetsSchema } from './facets.js';
import { documentRefSchema } from './search.js';
import { answerMediaSchema } from './track-citations.js';

/**
 * "Veja também" groups (KBC-003). Sources point to concept articles through kb's
 * relations (example_of, extends, related); a concept article lists, in reverse,
 * the documents that point to it.
 */
export const SEE_ALSO_GROUPS = [
  'exampleOf',
  'extends',
  'related',
  'examples',
  'extendedBy',
  'relatedFrom',
] as const;
export const seeAlsoGroupNameSchema = z.enum(SEE_ALSO_GROUPS);
export type SeeAlsoGroupName = z.infer<typeof seeAlsoGroupNameSchema>;

/**
 * A related document with the facets needed to judge it before opening (KBC-003 FR-3); a
 * track linked by kb carries its media and opens the T22 panel (KBC-101 FR-6).
 */
export const relatedDocumentSchema = documentRefSchema.extend({
  ...documentFacetsSchema.pick({ genre: true, depth: true, relevance: true })
    .shape,
  media: answerMediaSchema.optional(),
});
export type RelatedDocument = z.infer<typeof relatedDocumentSchema>;

/** Up to 5 references plus the full count, for "ver todos (n)". */
export const seeAlsoGroupSchema = z.object({
  items: z.array(relatedDocumentSchema),
  total: z.number().int().nonnegative(),
});
export type SeeAlsoGroup = z.infer<typeof seeAlsoGroupSchema>;

export const seeAlsoSchema = z.object({
  exampleOf: seeAlsoGroupSchema,
  extends: seeAlsoGroupSchema,
  related: seeAlsoGroupSchema,
  examples: seeAlsoGroupSchema,
  extendedBy: seeAlsoGroupSchema,
  relatedFrom: seeAlsoGroupSchema,
});
export type SeeAlso = z.infer<typeof seeAlsoSchema>;

/** How the text reached the vault, when not typed: audio transcription or OCR. */
export const documentOriginSchema = z.enum(['audio', 'ocr']).nullable();
export type DocumentOrigin = z.infer<typeof documentOriginSchema>;

export const documentSchema = documentFacetsSchema.extend({
  id: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  /** What a concept article covers (kb `criterion`), null for sources. */
  criterion: z.string().nullable(),
  /** The concept a concept article is about, as a track links it; null for sources. */
  concept: z.string().nullable(),
  origin: documentOriginSchema,
  /** Opens the file in the Obsidian vault. */
  obsidianUrl: z.string(),
  seeAlso: seeAlsoSchema,
  body: z.string(),
});
export type KbDocument = z.infer<typeof documentSchema>;

/** GET documents/:id/relations/:group — one page of a "Veja também" group. */
export const relationPageSchema = z.object({
  items: z.array(relatedDocumentSchema),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export type RelationPage = z.infer<typeof relationPageSchema>;
