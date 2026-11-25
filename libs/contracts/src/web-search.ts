import { z } from 'zod';
import {
  documentLinkSchema,
  uploadedDocumentRefSchema,
} from './document-uploads.js';

/* ---------- Searching the web for what to add to a collection (KBC-185) ---------- */

/** What a search looks for: web pages, or videos of YouTube and Vimeo. */
export const WEB_SEARCH_KINDS = ['page', 'video'] as const;
export const webSearchKindSchema = z.enum(WEB_SEARCH_KINDS);
export type WebSearchKind = z.infer<typeof webSearchKindSchema>;

/** Firecrawl refuses a query longer than this. */
export const WEB_SEARCH_QUERY = { min: 3, max: 500 } as const;
/** Results asked for per kind (each kind is a search of its own). */
export const WEB_SEARCH_LIMIT = { min: 5, max: 30, default: 10 } as const;
/** Under this many credits left, the screens warn (KBC-009 R5). */
export const WEB_SEARCH_LOW_CREDITS = 100;

/**
 * POST /api/v1/topics/:topic/web-search: who may send documents searches the web. Nothing is
 * added by it: the person picks, and what was picked is sent as links (KBC-149).
 */
export const webSearchRequestSchema = z.strictObject({
  query: z.string().trim().min(WEB_SEARCH_QUERY.min).max(WEB_SEARCH_QUERY.max),
  kinds: z
    .array(webSearchKindSchema)
    .min(1)
    .max(WEB_SEARCH_KINDS.length)
    .refine((kinds) => new Set(kinds).size === kinds.length, 'Repeated kind'),
  limit: z
    .number()
    .int()
    .min(WEB_SEARCH_LIMIT.min)
    .max(WEB_SEARCH_LIMIT.max)
    .default(WEB_SEARCH_LIMIT.default),
});
export type WebSearchRequest = z.infer<typeof webSearchRequestSchema>;
export type WebSearchRequestInput = z.input<typeof webSearchRequestSchema>;

/** A candidate: a page or a video, and whether the collection already has it. */
export const webSearchResultSchema = z.object({
  kind: webSearchKindSchema,
  url: documentLinkSchema,
  title: z.string().min(1).max(300),
  snippet: z.string().max(600),
  /** The address' host, without `www.`. */
  site: z.string().max(253),
  /**
   * The link is already in the collection (or on its way to it); `document` is null while it
   * is on its way, or when it is above the person's level (ADR 0036).
   */
  already: z
    .object({ document: uploadedDocumentRefSchema.nullable() })
    .nullable(),
});
export type WebSearchResult = z.infer<typeof webSearchResultSchema>;

export const webSearchResponseSchema = z.object({
  results: z.array(webSearchResultSchema),
  /** Kinds whose search did not work while the other one did (it was paid for). */
  failedKinds: z.array(webSearchKindSchema),
  creditsUsed: z.number().min(0),
  /** Null while the balance is not known (since the server started). */
  creditsRemaining: z.number().min(0).nullable(),
  low: z.boolean(),
});
export type WebSearchResponse = z.infer<typeof webSearchResponseSchema>;

/** GET /api/v1/web-search/available: for anyone who may send documents, with no balance. */
export const webSearchAvailabilitySchema = z.object({
  connected: z.boolean(),
  low: z.boolean(),
});
export type WebSearchAvailability = z.infer<typeof webSearchAvailabilitySchema>;

/** Why the stored key does not search now: Firecrawl refused it, or did not answer. */
export const WEB_SEARCH_PROBLEMS = ['key-rejected', 'unreachable'] as const;
export const webSearchProblemSchema = z.enum(WEB_SEARCH_PROBLEMS);
export type WebSearchProblem = z.infer<typeof webSearchProblemSchema>;

export const webSearchCreditsSchema = z.object({
  remaining: z.number().min(0),
  /** The plan's credits per period; null when Firecrawl does not say. */
  plan: z.number().min(0).nullable(),
  periodEnd: z.iso.datetime().nullable(),
});
export type WebSearchCredits = z.infer<typeof webSearchCreditsSchema>;

/** GET /api/v1/web-search/settings (masters): never the key, only its last 4 characters. */
export const webSearchSettingsSchema = z.object({
  /** A key is stored (sealed, ADR 0017). */
  connected: z.boolean(),
  keyHint: z.string().length(4).nullable(),
  /** The last balance read; null when none was. */
  credits: webSearchCreditsSchema.nullable(),
  low: z.boolean(),
  checkedAt: z.iso.datetime().nullable(),
  problem: webSearchProblemSchema.nullable(),
});
export type WebSearchSettings = z.infer<typeof webSearchSettingsSchema>;

/** PUT /api/v1/web-search/settings: tested first, kept only when Firecrawl accepts it. */
export const webSearchKeyRequestSchema = z.strictObject({
  key: z
    .string()
    .trim()
    .min(8)
    .max(500)
    // What an HTTP header takes: anything else is a wrong paste.
    .regex(/^[\x21-\x7e]+$/, 'Not a key'),
});
export type WebSearchKeyRequest = z.infer<typeof webSearchKeyRequestSchema>;
