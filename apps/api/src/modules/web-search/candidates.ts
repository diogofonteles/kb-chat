import {
  documentLinkSchema,
  isMediaHost,
  mediaLinkOf,
  type MediaLinkKind,
  type WebSearchKind,
  type WebSearchResult,
} from '@kb-chat/contracts';
import type { WebHit } from '../../ports/web-search.js';
import type { SearchGroup } from './search-plan.js';

/** A result before it is known whether the collection already has it. */
export type Candidate = Omit<WebSearchResult, 'already'>;

const TITLE_MAX = 300;
const SNIPPET_MAX = 600;

const itemOf = (kind: MediaLinkKind) => (url: string) => {
  const item = mediaLinkOf(url);
  return item?.kind === kind ? item.url : null;
};

/** The address a hit has as this kind, or null when it is not one. */
const ADDRESS_OF: Record<WebSearchKind, (url: string) => string | null> = {
  text: (url) => (isMediaHost(url) ? null : url),
  audio: itemOf('audio'),
  video: itemOf('video'),
};

const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
};

/**
 * The hits of one search as candidates: only addresses the app takes as a link; an audio or
 * a video only as its own page, and a text never of an audio or video site.
 */
export function candidatesOf(
  hits: readonly WebHit[],
  { kind, author }: Pick<SearchGroup, 'kind' | 'author'>,
): Candidate[] {
  return hits.flatMap((hit) => {
    const link = documentLinkSchema.safeParse(ADDRESS_OF[kind](hit.url));
    if (!link.success) return [];
    const site = new URL(link.data).hostname.replace(/^www\./, '');
    return {
      kind,
      url: link.data,
      title: oneLine(hit.title, TITLE_MAX) || site,
      snippet: oneLine(hit.description, SNIPPET_MAX),
      site,
      author,
    };
  });
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
 * The candidates of every search, one of each in turn, up to `sources`: no kind and no author
 * takes the list over. A page found by two searches stays with the first that reaches it.
 */
export function interleave(
  groups: readonly (readonly Candidate[])[],
  sources: number,
): Candidate[] {
  const queues = groups.map((group) => [...group]);
  const seen = new Set<string>();
  const taken: Candidate[] = [];
  while (taken.length < sources && queues.some((queue) => queue.length > 0))
    taken.push(...queues.flatMap((queue) => nextUnseen(queue, seen)));
  return taken.slice(0, sources);
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
