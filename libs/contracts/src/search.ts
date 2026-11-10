import { z } from 'zod';
import { topicSlugSchema } from './topics.js';
import { contentLevelSchema } from './access-levels.js';
import {
  mediaAuthorSchema,
  mediaIdSchema,
  transcriptConfidenceSchema,
} from './media.js';
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
  /**
   * KBC-048 FR-4: searching a parent, only these of its collections (itself or its
   * sub-collections); none selected = all of them.
   */
  topics: z.array(topicSlugSchema).max(50).default([]),
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
  topics: [],
};

/**
 * What a search looks in (KBC-039 FR-5, BR-4): the vault's texts and the transcripts of
 * the collection's audio. Video joins with KBC-075.
 */
export const SEARCH_KINDS = ['text', 'audio'] as const;
export const searchKindSchema = z.enum(SEARCH_KINDS);
export type SearchKind = z.infer<typeof searchKindSchema>;

/** Spoken passages returned with a search (KBC-039 FR-2). */
export const MAX_MEDIA_HITS = 5;
/** Matching passages are counted up to this many ("1000+" on the screen). */
export const MEDIA_COUNT_CAP = 1000;

const searchRequestShape = z.strictObject({
  /** Empty only with a subject chosen: then the subject alone searches (KBC-070 BR-2). */
  q: z.string().trim().max(500),
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
    topics: [],
  })),
  /** Never empty: at least one kind stays chosen (BR-4); default every kind. */
  kinds: z
    .array(searchKindSchema)
    .min(1)
    .max(SEARCH_KINDS.length)
    .refine((kinds) => new Set(kinds).size === kinds.length, {
      error: 'Each kind at most once',
    })
    .default(() => [...SEARCH_KINDS]),
});

export const searchRequestSchema = searchRequestShape.refine(
  ({ q, filters }) => q.length > 0 || filters.concepts.length > 0,
  { error: 'Too small: expected a question or a subject', path: ['q'] },
);
export type SearchRequest = z.input<typeof searchRequestSchema>;

export const documentRefSchema = z.object({
  id: z.string(),
  title: z.string(),
});
export type DocumentRef = z.infer<typeof documentRefSchema>;

/** Characters of a passage's text that matched the question, end exclusive. */
export const textRangeSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
export type TextRange = z.infer<typeof textRangeSchema>;

/**
 * A track (or a recording without tracks) as a document of the collection (KBC-101 FR-8,
 * ADR 0035 amendment 2026-11-07): what the ♪ card shows and where the T22 panel opens. The
 * passage is exact from media.db, on the track's clock.
 */
export const searchHitMediaSchema = z.object({
  mediaId: mediaIdSchema,
  kind: z.enum(['track', 'recording']),
  recordingTitle: z.string(),
  ordinal: z.number().int().min(1).optional(),
  total: z.number().int().min(1).optional(),
  durationMs: z.number().int().nonnegative(),
  /** The matched passage: the "Na fala" one when merged, else the index snippet's paragraph. */
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  confidence: transcriptConfidenceSchema,
  /** The vault's text is behind media.db ("atualizando", KBC-100). */
  stale: z.boolean(),
  /** The spoken sentence of a merged "Na fala" passage, with the words found (BR-8). */
  spoken: z
    .object({ text: z.string(), highlights: z.array(textRangeSchema) })
    .optional(),
});
export type SearchHitMedia = z.infer<typeof searchHitMediaSchema>;

export const searchHitSchema = documentFacetsSchema.extend({
  /** The collection the document is in: a sub-collection when searching its parent. */
  topic: topicSlugSchema,
  id: z.string(),
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
  /** Other documents with the same normalized title (near-identical copies). */
  copies: z.array(documentRefSchema),
  /** Present when the document is a track of the collection (KBC-101). */
  media: searchHitMediaSchema.optional(),
  /** Its level, for whoever manages levels in a collection with a scale (KBC-103 AC-9). */
  level: contentLevelSchema.optional(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

/**
 * A subject in the filter: documents, plus the tracks linked to it for who has
 * `media-subjects` (KBC-070 BR-4). Absent means the person is not told; 0 documents with
 * tracks is a subject only tracks have.
 */
export const conceptCountSchema = z.object({
  value: z.string(),
  count: z.number().int(),
  tracks: z.number().int().nonnegative().optional(),
});
export type ConceptCount = z.infer<typeof conceptCountSchema>;

const facetCountSchema = <T extends z.ZodType>(value: T) =>
  z.array(z.object({ value, count: z.number().int() }));

/** Counts per facet value over the results, each facet ignoring its own selection (disjunctive). */
export const resultFacetsSchema = z.object({
  concepts: z.array(conceptCountSchema),
  genres: facetCountSchema(genreSchema),
  depths: facetCountSchema(depthLevelSchema),
  relevances: facetCountSchema(relevanceSchema),
  authorships: facetCountSchema(authorshipSchema),
  /** Per collection searched: a parent and its sub-collections (KBC-048 FR-4). */
  topics: facetCountSchema(topicSlugSchema),
});
export type ResultFacets = z.infer<typeof resultFacetsSchema>;

/** A subject shown on a result: only accepted ones (KBC-069 BR-3) of the collection now. */
export const hitSubjectSchema = z.object({
  /** `concept:<key>` or `free:<id>`, the library's filter value. */
  key: z.string(),
  name: z.string(),
});
export type HitSubject = z.infer<typeof hitSubjectSchema>;

/** Why a media hit is on the list: words said in it, or its subject, title or summary. */
export const MEDIA_MATCHES = ['speech', 'subject'] as const;
export const mediaMatchSchema = z.enum(MEDIA_MATCHES);
export type MediaMatch = z.infer<typeof mediaMatchSchema>;

/**
 * One spoken passage that matched (KBC-039 FR-2, ADR 0024 §2): a segment of the current
 * transcript of an audio the person may hear, opened at `startMs − 2 s`.
 */
export const mediaHitSchema = z.object({
  mediaId: mediaIdSchema,
  /** The collection the audio is in: a sub-collection when searching its parent. */
  topic: topicSlugSchema,
  title: z.string(),
  /** The authorship group of the filter: the collection's main author or the others. */
  authorship: authorshipSchema,
  author: mediaAuthorSchema,
  /** The segment's text. */
  text: z.string(),
  highlights: z.array(textRangeSchema),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  /** The transcript's verdict (KBC-036): `low` shows the "baixa confiança" badge (BR-3). */
  confidence: transcriptConfidenceSchema,
  /** Relevance from 0 to 1, comparable with the documents' to mix them (FR-6). */
  score: z.number().min(0).max(1),
  /** `subject`: a whole track with its summary as `text`, opened at the start (KBC-070). */
  match: mediaMatchSchema.default('speech'),
  /** A track's subjects, for who has `media-subjects`. */
  subjects: z.array(hitSubjectSchema).default([]),
});
export type MediaHit = z.infer<typeof mediaHitSchema>;

/**
 * Matches per kind, whatever kinds were chosen (like a facet); `audio` is null when the
 * collection has no audio the person may hear (the choice is then disabled, FR-5).
 */
export const kindCountsSchema = z.object({
  text: z.number().int().nonnegative(),
  /** Up to MEDIA_COUNT_CAP. */
  audio: z.number().int().nonnegative().max(MEDIA_COUNT_CAP).nullable(),
});
export type KindCounts = z.infer<typeof kindCountsSchema>;

export const searchResponseSchema = z.object({
  items: z.array(searchHitSchema),
  /** Spoken passages, best first (empty when audio is not chosen or not available). */
  media: z.array(mediaHitSchema).max(MAX_MEDIA_HITS).default([]),
  kinds: kindCountsSchema.default({ text: 0, audio: null }),
  /** Result cards (copy groups) matching the filters among the index candidates. */
  total: z.number().int().nonnegative(),
  /** Of those, track documents (KBC-101): "7 documentos (1 faixa)". */
  trackTotal: z.number().int().nonnegative().default(0),
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

/** One track linked to a subject, as "Veja também" lists it (KBC-070 FR-3). */
export const subjectTrackSchema = z.object({
  id: mediaIdSchema,
  topic: topicSlugSchema,
  title: z.string(),
  author: mediaAuthorSchema,
  durationMs: z.number().int().nonnegative().nullable(),
  summary: z.string().nullable(),
  /** The recording it was cut from. */
  parentTitle: z.string(),
});
export type SubjectTrack = z.infer<typeof subjectTrackSchema>;

/** `GET /api/v1/topics/{topic}/concepts/{name}/media`: most recent first. */
export const subjectTracksPageSchema = z.object({
  items: z.array(subjectTrackSchema),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export type SubjectTracksPage = z.infer<typeof subjectTracksPageSchema>;

/** Tracks shown on a concept's panel before "Ver todas" (KBC-070). */
export const SUBJECT_TRACKS_PREVIEW = 5;
export const SUBJECT_TRACKS_PAGE_MAX = 50;
/** Far past any subject's tracks: the query's number has bounds (`z.coerce`). */
export const SUBJECT_TRACKS_OFFSET_MAX = 100_000;

export const subjectTracksQuerySchema = z.object({
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .max(SUBJECT_TRACKS_OFFSET_MAX)
    .default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SUBJECT_TRACKS_PAGE_MAX)
    .default(SUBJECT_TRACKS_PREVIEW),
});

/** `GET /api/v1/media/{id}/about`: what a listener reads about a track (KBC-070). */
export const trackAboutSchema = z.object({
  subjects: z.array(hitSubjectSchema),
  summary: z.string().nullable(),
});
export type TrackAbout = z.infer<typeof trackAboutSchema>;

/** Collection-wide counts per facet value (GET /topics/:topic/facets). */
export const topicFacetsSchema = resultFacetsSchema;
export type TopicFacets = ResultFacets;
