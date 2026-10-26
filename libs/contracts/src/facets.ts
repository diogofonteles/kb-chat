import { z } from 'zod';

/** kb `genre` values (decision-model facet). */
export const GENRES = [
  'article_or_essay',
  'talk_or_interview',
  'tutorial_or_guide',
  'reference_docs',
  'paper',
  'announcement_or_news',
  'other',
] as const;
export const genreSchema = z.enum(GENRES);
export type Genre = z.infer<typeof genreSchema>;

/** kb `relevance` roles against the topic's selection contract. */
export const RELEVANCES = [
  'core',
  'adjacent',
  'collected_on_purpose',
  'general',
  'off_topic',
] as const;
export const relevanceSchema = z.enum(RELEVANCES);
export type Relevance = z.infer<typeof relevanceSchema>;

/** kb `depth` (0–3, possibly fractional) bucketed to its integer level. */
export const DEPTH_LEVELS = [0, 1, 2, 3] as const;
export const depthLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type DepthLevel = z.infer<typeof depthLevelSchema>;

/**
 * Whose text a document is (KBC-020, ADR 0015), read only from the owner-managed
 * `author_group` frontmatter key: the work of José Laércio do Egito ("Mestre Laércio"),
 * books and texts by other authors, a wiki article that synthesizes the collection, or a
 * document the owner has not marked yet (never guessed).
 */
export const AUTHORSHIPS = [
  'mestre-laercio',
  'outros-autores',
  'sintese',
  'nao-classificado',
] as const;
export const authorshipSchema = z.enum(AUTHORSHIPS);
export type Authorship = z.infer<typeof authorshipSchema>;

export const documentFacetsSchema = z.object({
  genre: genreSchema.nullable(),
  depth: depthLevelSchema.nullable(),
  relevance: relevanceSchema.nullable(),
  concepts: z.array(z.string()),
  authorship: authorshipSchema,
  /** The frontmatter `author`, when the owner set one. */
  author: z.string().nullable(),
});
export type DocumentFacets = z.infer<typeof documentFacetsSchema>;
