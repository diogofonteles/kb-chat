import {
  documentLinkSchema,
  type WebSearchKind,
  type WebSearchResult,
} from '@kb-chat/contracts';
import type { WebHit } from '../../ports/web-search.js';
import { isVideoSite, videoPageOf } from './video-page.js';

/** A result before it is known whether the collection already has it. */
export type Candidate = Omit<WebSearchResult, 'already'>;

const TITLE_MAX = 300;
const SNIPPET_MAX = 600;

/** The address a hit has as this kind, or null when it is not one. */
const ADDRESS_OF: Record<WebSearchKind, (url: string) => string | null> = {
  page: (url) => (isVideoSite(url) ? null : url),
  video: videoPageOf,
};

const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
};

/**
 * The hits of a search as candidates: only addresses the app takes as a link, each one once,
 * at most `limit`; a video only as its own page, and a page never of a video site.
 */
export function candidatesOf(
  hits: readonly WebHit[],
  { kind, limit }: { readonly kind: WebSearchKind; readonly limit: number },
): Candidate[] {
  const byUrl = new Map<string, Candidate>();
  for (const hit of hits) {
    const link = documentLinkSchema.safeParse(ADDRESS_OF[kind](hit.url));
    if (!link.success || byUrl.has(link.data)) continue;
    const site = new URL(link.data).hostname.replace(/^www\./, '');
    byUrl.set(link.data, {
      kind,
      url: link.data,
      title: oneLine(hit.title, TITLE_MAX) || site,
      snippet: oneLine(hit.description, SNIPPET_MAX),
      site,
    });
  }
  return [...byUrl.values()].slice(0, limit);
}
