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

/* ---------- Links of audio and video the app takes as recordings (KBC-009 R6) ---------- */

export type MediaLinkKind = Exclude<WebSearchKind, 'text'>;

export interface MediaLink {
  readonly kind: MediaLinkKind;
  /** The one address of the item, without what a search or a share adds to it. */
  readonly url: string;
}

const YOUTUBE_ID = /^[\w-]{11}$/;
const VIMEO_PATH = /^\/(\d+)\/?$/;
const ARCHIVE_PATH = /^\/details\/([^/@][^/]*)/;
/** Pages of SoundCloud that are no user's, and pages of a user that are no track. */
const SOUNDCLOUD_PLACES = new Set(
  'charts discover feed pages people popular search settings stream tags upload you'.split(
    ' ',
  ),
);
const SOUNDCLOUD_LISTS = new Set(
  'albums comments followers following likes popular-tracks reposts sets spotlight toptracks tracks'.split(
    ' ',
  ),
);

function parsedLink(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** The host without the `www.` or the `m.` of a phone. */
const hostOf = (url: URL): string => url.hostname.replace(/^(www|m)\./, '');

/** The id in `watch?v=`, `/shorts/` or `youtu.be/`. */
function youtubeItem(url: URL): string | null {
  const [, first = '', second = ''] = url.pathname.split('/');
  const inPath = first === 'shorts' ? second : null;
  const inQuery = first === 'watch' ? url.searchParams.get('v') : null;
  const id = hostOf(url) === 'youtu.be' ? first : (inPath ?? inQuery);
  return id && YOUTUBE_ID.test(id)
    ? `https://www.youtube.com/watch?v=${id}`
    : null;
}

function vimeoItem(url: URL): string | null {
  const id = VIMEO_PATH.exec(url.pathname)?.[1];
  return id ? `https://vimeo.com/${id}` : null;
}

function soundcloudItem(url: URL): string | null {
  const [user = '', track = '', ...rest] = url.pathname
    .split('/')
    .filter((part) => part !== '');
  const isTrack =
    track !== '' &&
    rest.length === 0 &&
    !SOUNDCLOUD_PLACES.has(user) &&
    !SOUNDCLOUD_LISTS.has(track);
  return isTrack ? `https://soundcloud.com/${user}/${track}` : null;
}

function archiveItem(url: URL): string | null {
  const id = ARCHIVE_PATH.exec(url.pathname)?.[1];
  return id ? `https://archive.org/details/${id}` : null;
}

function podcastEpisode(url: URL): string | null {
  const episode = url.searchParams.get('i');
  if (!episode || !/^\d+$/.test(episode)) return null;
  // The same episode has an address per country: one of them is its address here.
  const path = url.pathname.replace(/^\/[a-z]{2}\//, '/');
  return `https://podcasts.apple.com/br${path}?i=${episode}`;
}

/** How each site's item is read from an address; anything else there is no item. */
const SITES = new Map<
  string,
  { kind: MediaLinkKind; item: (url: URL) => string | null }
>([
  ['youtube.com', { kind: 'video', item: youtubeItem }],
  ['music.youtube.com', { kind: 'video', item: youtubeItem }],
  ['youtu.be', { kind: 'video', item: youtubeItem }],
  ['vimeo.com', { kind: 'video', item: vimeoItem }],
  ['soundcloud.com', { kind: 'audio', item: soundcloudItem }],
  ['archive.org', { kind: 'audio', item: archiveItem }],
  ['podcasts.apple.com', { kind: 'audio', item: podcastEpisode }],
]);

/**
 * The audio or the video an address is the page of: a YouTube watch, shorts or youtu.be page,
 * a numeric Vimeo one, a SoundCloud track, an Internet Archive item, an Apple Podcasts
 * episode. Null for a channel, a playlist, a profile or any other page.
 */
export function mediaLinkOf(url: string): MediaLink | null {
  const parsed = parsedLink(url);
  const site = parsed && SITES.get(hostOf(parsed));
  if (!parsed || !site) return null;
  const item = site.item(parsed);
  return item ? { kind: site.kind, url: item } : null;
}

export const mediaLinkKind = (url: string): MediaLinkKind | null =>
  mediaLinkOf(url)?.kind ?? null;

/** An address of one of those sites, an item or not: never a text to read. */
export function isMediaHost(url: string): boolean {
  const parsed = parsedLink(url);
  if (!parsed) return false;
  const host = hostOf(parsed);
  // A subdomain is the same site but the Internet Archive's (web.archive.org keeps pages).
  return [...SITES.keys()].some(
    (site) =>
      host === site || (site !== 'archive.org' && host.endsWith(`.${site}`)),
  );
}

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
