import { z } from 'zod';
import { documentFacetsSchema } from './facets.js';

/** UI modes: all = lexical + vector fused, exact = lexical, semantic = vector. */
export const SEARCH_MODES = ['all', 'exact', 'semantic'] as const;
export const searchModeSchema = z.enum(SEARCH_MODES);
export type SearchMode = z.infer<typeof searchModeSchema>;

export const searchRequestSchema = z.strictObject({
  q: z.string().trim().min(1).max(500),
  mode: searchModeSchema.default('all'),
  limit: z.number().int().min(1).max(50).default(10),
});
export type SearchRequest = z.input<typeof searchRequestSchema>;

export const searchHitSchema = documentFacetsSchema.extend({
  id: z.string(),
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchResponseSchema = z.object({
  items: z.array(searchHitSchema),
  total: z.number().int().nonnegative(),
  mode: searchModeSchema,
  tookMs: z.number().nonnegative(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
