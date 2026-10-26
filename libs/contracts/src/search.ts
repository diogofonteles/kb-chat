import { z } from 'zod';
import {
  authorshipSchema,
  depthLevelSchema,
  documentFacetsSchema,
  genreSchema,
  relevanceSchema,
} from './facets.js';

/** UI modes: all = lexical + vector fused, exact = lexical, semantic = vector. */
export const SEARCH_MODES = ['all', 'exact', 'semantic'] as const;
export const searchModeSchema = z.enum(SEARCH_MODES);
export type SearchMode = z.infer<typeof searchModeSchema>;

/** Results reachable through "Mostrar mais" (KBC-002 FR-4). */
export const MAX_RESULTS = 50;

/**
 * Facet filters: values of one facet combine with OR, different facets with AND.
 * Off-topic documents are hidden unless `relevances` includes "off_topic", which adds
 * them to whatever the other relevance values select (none selected = any relevance).
 */
export const searchFiltersSchema = z.strictObject({
  concepts: z.array(z.string().min(1).max(200)).max(50).default([]),
  genres: z.array(genreSchema).default([]),
  depths: z.array(depthLevelSchema).default([]),
  relevances: z.array(relevanceSchema).default([]),
  /** KBC-020: none selected = every authorship ("Todos"). */
  authorships: z.array(authorshipSchema).max(4).default([]),
});
export type SearchFilters = z.infer<typeof searchFiltersSchema>;
export type SearchFiltersInput = z.input<typeof searchFiltersSchema>;

/** No facet selected: every result except off-topic (KBC-002 BR-2). */
export const EMPTY_FILTERS: SearchFilters = {
  concepts: [],
  genres: [],
  depths: [],
  relevances: [],
  authorships: [],
};

export const searchRequestSchema = z.strictObject({
  q: z.string().trim().min(1).max(500),
  mode: searchModeSchema.default('all'),
  limit: z.number().int().min(1).max(MAX_RESULTS).default(10),
  offset: z.number().int().min(0).max(MAX_RESULTS).default(0),
  // A fresh object per request: the default is copied shallowly (TS-09).
  filters: searchFiltersSchema.default(() => ({
    concepts: [],
    genres: [],
    depths: [],
    relevances: [],
    authorships: [],
  })),
});
export type SearchRequest = z.input<typeof searchRequestSchema>;

export const documentRefSchema = z.object({
  id: z.string(),
  title: z.string(),
});
export type DocumentRef = z.infer<typeof documentRefSchema>;

export const searchHitSchema = documentFacetsSchema.extend({
  id: z.string(),
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
  /** Other documents with the same normalized title (near-identical copies). */
  copies: z.array(documentRefSchema),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

const facetCountSchema = <T extends z.ZodType>(value: T) =>
  z.array(z.object({ value, count: z.number().int() }));

/** Counts per facet value over the results, each facet ignoring its own selection (disjunctive). */
export const resultFacetsSchema = z.object({
  concepts: facetCountSchema(z.string()),
  genres: facetCountSchema(genreSchema),
  depths: facetCountSchema(depthLevelSchema),
  relevances: facetCountSchema(relevanceSchema),
  authorships: facetCountSchema(authorshipSchema),
});
export type ResultFacets = z.infer<typeof resultFacetsSchema>;

export const searchResponseSchema = z.object({
  items: z.array(searchHitSchema),
  /** Result cards (copy groups) matching the filters among the index candidates. */
  total: z.number().int().nonnegative(),
  /** True when the index returned its candidate cap, so there may be more. */
  capped: z.boolean(),
  /** Offset of the next page for "Mostrar mais", or null. */
  nextOffset: z.number().int().nonnegative().nullable(),
  /** Off-topic cards hidden by default that match the other filters. */
  hiddenOffTopic: z.number().int().nonnegative(),
  facets: resultFacetsSchema,
  mode: searchModeSchema,
  tookMs: z.number().nonnegative(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

/** Collection-wide counts per facet value (GET /topics/:topic/facets). */
export const topicFacetsSchema = resultFacetsSchema;
export type TopicFacets = ResultFacets;
