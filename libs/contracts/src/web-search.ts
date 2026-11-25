import { z } from 'zod';
import {
  documentLinkSchema,
  uploadedDocumentRefSchema,
} from './document-uploads.js';

/* ---------- Searching the web for what to add to a collection (KBC-185) ---------- */

/** What a search looks for. */
export const WEB_SEARCH_KINDS = ['text', 'audio', 'video'] as const;
export const webSearchKindSchema = z.enum(WEB_SEARCH_KINDS);
export type WebSearchKind = z.infer<typeof webSearchKindSchema>;

/** Firecrawl refuses a query longer than this. */
export const WEB_SEARCH_QUERY = { min: 3, max: 500 } as const;
/** The sources wanted in all: as many as the person asks, the web being what ends them. */
export const WEB_SEARCH_SOURCES = { min: 1, default: 10 } as const;
/** What one request gives: a larger search is several, its results coming in as they arrive. */
export const WEB_SEARCH_STEP = 30;
/** The length of a reference author's name; there are as many as are named. */
export const WEB_SEARCH_AUTHORS = { nameMin: 2, nameMax: 80 } as const;
/** What a Firecrawl query costs, and what it usually brings that is about the subject. */
export const WEB_SEARCH_QUERY_CREDITS = 2;
const USEFUL_PER_QUERY = 4;
/** Under this many credits left, the screens warn (KBC-009 R5). */
export const WEB_SEARCH_LOW_CREDITS = 100;

/** A name as it is searched for: the double quotes are the search's own. */
export const withoutQuotes = (text: string): string =>
  text.replace(/["“”]/g, ' ').replace(/\s+/g, ' ').trim();

/** The same author, whatever the case and the quotes around the name. */
export const sameAuthor = (one: string, other: string): boolean =>
  withoutQuotes(one).toLowerCase() === withoutQuotes(other).toLowerCase();

export const webSearchAuthorSchema = z
  .string()
  .trim()
  .min(WEB_SEARCH_AUTHORS.nameMin)
  .max(WEB_SEARCH_AUTHORS.nameMax)
  .refine(
    (name) => withoutQuotes(name).length >= WEB_SEARCH_AUTHORS.nameMin,
    'Not a name',
  );

/** The names typed at once, separated by commas, semicolons or lines. */
export const authorsIn = (text: string): string[] =>
  text
    .split(/[,;\n]+/)
    .map((name) => name.replace(/\s+/g, ' ').trim())
    .filter((name) => name !== '');

/** About how many Firecrawl credits a search takes: a query per kind and author at least. */
export const webSearchCredits = (wanted: {
  readonly sources: number;
  readonly kinds: number;
  readonly authors: number;
}): number =>
  WEB_SEARCH_QUERY_CREDITS *
  Math.max(
    wanted.kinds * Math.max(1, wanted.authors),
    Math.ceil(wanted.sources / USEFUL_PER_QUERY),
  );

/**
 * POST /api/v1/topics/:topic/web-search: who may send documents searches the web. Nothing is
 * added by it: the person picks, and what was picked is sent as links (KBC-149). The same
 * `search` again goes on from where it stopped: what the person was given does not come back,
 * now or in another day's search of the collection, unless `again` asks for it.
 */
export const webSearchRequestSchema = z.strictObject({
  /** This search: the same one goes on, another (or none) starts over. */
  search: z.uuid().optional(),
  query: z.string().trim().min(WEB_SEARCH_QUERY.min).max(WEB_SEARCH_QUERY.max),
  sources: z
    .number()
    .int()
    .min(WEB_SEARCH_SOURCES.min)
    .max(WEB_SEARCH_STEP)
    .default(WEB_SEARCH_SOURCES.default),
  kinds: z
    .array(webSearchKindSchema)
    .min(1)
    .max(WEB_SEARCH_KINDS.length)
    .refine((kinds) => new Set(kinds).size === kinds.length, 'Repeated kind')
    .default([...WEB_SEARCH_KINDS]),
  authors: z
    .array(webSearchAuthorSchema)
    .refine(
      (names) =>
        names.every(
          (name, at) =>
            names.findIndex((other) => sameAuthor(name, other)) === at,
        ),
      'Repeated author',
    )
    .default([]),
  /** Also what the person was already given, and what the collection already has. */
  again: z.boolean().default(false),
});
export type WebSearchRequest = z.infer<typeof webSearchRequestSchema>;
export type WebSearchRequestInput = z.input<typeof webSearchRequestSchema>;

/** A candidate: where it is, whose search found it, and whether the collection has it. */
export const webSearchResultSchema = z.object({
  kind: webSearchKindSchema,
  url: documentLinkSchema,
  title: z.string().min(1).max(300),
  snippet: z.string().max(600),
  /** The address' host, without `www.`. */
  site: z.string().max(253),
  /** The reference author it names; null when it names none (or none was asked). */
  author: z.string().nullable(),
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
  /** Some of the searches did not answer: the results are of the ones that did. */
  partial: z.boolean(),
  /** Nothing else is found for this request: asking again gives nothing new. */
  exhausted: z.boolean(),
  /** Found and left out: the collection has it, or the person was given it before. */
  skipped: z.object({
    already: z.number().int().min(0),
    seen: z.number().int().min(0),
  }),
  creditsUsed: z.number().min(0),
  /** Masters only; null to anyone else, and while the balance is not known. */
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
