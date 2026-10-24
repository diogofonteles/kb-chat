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

export const documentFacetsSchema = z.object({
  genre: genreSchema.nullable(),
  depth: depthLevelSchema.nullable(),
  relevance: relevanceSchema.nullable(),
  concepts: z.array(z.string()),
});
export type DocumentFacets = z.infer<typeof documentFacetsSchema>;
