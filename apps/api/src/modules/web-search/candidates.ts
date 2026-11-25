import {
  documentLinkSchema,
  isMediaHost,
  mediaLinkOf,
  type MediaLinkKind,
  type WebSearchKind,
  type WebSearchResult,
} from '@kb-chat/contracts';
import type { WebHit } from '../../ports/web-search.js';
import { relevanceOf, type Relevance } from './relevance.js';

/** A result before it is known whether the collection already has it. */
export type Candidate = Omit<WebSearchResult, 'already'>;

const TITLE_MAX = 300;
const SNIPPET_MAX = 600;

const itemOf = (kind: MediaLinkKind) => (url: string) => {
  const item = mediaLinkOf(url);
  return item?.kind === kind ? item.url : null;
};

/**
 * Sites that are no text to read: a social network answers with its sign-in page, a shop with
 * its product, and the engine's own redirects lead nowhere.
 */
const NO_TEXT = [
  /(^|\.)(instagram|tiktok|facebook|fb|threads|pinterest|twitter|x|linkedin|kwai)\.(com|net)(\.\w+)?$/,
  /(^|\.)(amazon|mercadolivre|mercadolibre|shopee|magazineluiza|magalu|americanas|estantevirtual|aliexpress|ebay)\.\w+(\.\w+)?$/,
  /(^|\.)google\.\w+(\.\w+)?$/,
  /(^|\.)pinterest\.\w+(\.\w+)?$/,
];

const isText = (url: string): boolean => {
  if (isMediaHost(url) || !URL.canParse(url)) return false;
  const { hostname } = new URL(url);
  return !NO_TEXT.some((site) => site.test(hostname));
};

/** The address a hit has as this kind, or null when it is not one. */
const ADDRESS_OF: Record<WebSearchKind, (url: string) => string | null> = {
  text: (url) => (isText(url) ? url : null),
  audio: itemOf('audio'),
  video: itemOf('video'),
};

const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
};

/** What was asked: the subject, and the search that asked it. */
export interface AskedOf {
  readonly subject: string;
  readonly kind: WebSearchKind;
  readonly author: string | null;
}

/** Both, then the author's on something else, then the subject by anyone. */
const rankOf = ({ subject, author }: Relevance): number =>
  author ? (subject ? 0 : 1) : 2;

/**
 * The hits of one search as candidates: only addresses the app takes as a link; an audio or
 * a video only as its own page, and a text never of an audio or video site, a social network
 * or a shop; and only what has to do with the subject or the author, the closest first.
 */
export function candidatesOf(
  hits: readonly WebHit[],
  asked: AskedOf,
): Candidate[] {
  return hits
    .flatMap((hit) => {
      const link = documentLinkSchema.safeParse(
        ADDRESS_OF[asked.kind](hit.url),
      );
      if (!link.success) return [];
      const shown = { ...shownOf(hit), url: link.data };
      const relevance = relevanceOf(shown, asked);
      if (!relevance.subject && !relevance.author) return [];
      return [
        {
          rank: rankOf(relevance),
          candidate: toCandidate(shown, asked, relevance),
        },
      ];
    })
    .sort((one, other) => one.rank - other.rank)
    .map(({ candidate }) => candidate);
}

const shownOf = (hit: WebHit) => ({
  title: oneLine(hit.title, TITLE_MAX),
  snippet: oneLine(hit.description, SNIPPET_MAX),
});

function toCandidate(
  shown: { title: string; snippet: string; url: string },
  { kind, author }: AskedOf,
  relevance: Relevance,
): Candidate {
  const site = new URL(shown.url).hostname.replace(/^www\./, '');
  return {
    ...shown,
    kind,
    title: shown.title || site,
    site,
    author: relevance.author ? author : null,
  };
}

/** What a link carries about who shared it, not about what it is. */
const TRACKING = /^(utm_\w+|fbclid|gclid|igshid|mc_cid|mc_eid|ref_src)$/;

/** The same page, whatever the scheme, the `www.`, the place in it or who shared it. */
export function pageKey(url: string): string {
  const { hostname, port, pathname, searchParams } = new URL(url);
  const kept = [...searchParams]
    .filter(([name]) => !TRACKING.test(name))
    .map(([name, value]) => `${name}=${value}`)
    .sort();
  const host = hostname.replace(/^www\./, '');
  return `${host}:${port}${pathname.replace(/\/+$/, '')}?${kept.join('&')}`;
}

/**
 * The candidates of every search, one of each in turn: no kind and no author takes the list
 * over. A page found by two searches stays with the first that reaches it, and one in `known`
 * is left out.
 */
export function interleave(
  groups: readonly (readonly Candidate[])[],
  known: ReadonlySet<string> = new Set(),
): Candidate[] {
  const queues = groups.map((group) => [...group]);
  const seen = new Set(known);
  const taken: Candidate[] = [];
  while (queues.some((queue) => queue.length > 0))
    taken.push(...queues.flatMap((queue) => nextUnseen(queue, seen)));
  return taken;
}

/** The first candidate of the queue not taken yet, marked as taken; none when it ended. */
function nextUnseen(queue: Candidate[], seen: Set<string>): Candidate[] {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const key = pageKey(next.url);
    if (seen.has(key)) continue;
    seen.add(key);
    return [next];
  }
  return [];
}
