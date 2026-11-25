import {
  WEB_AUDIO_HOSTS,
  WEB_SEARCH_QUERY,
  WEB_VIDEO_HOSTS,
  withoutQuotes,
  type WebSearchKind,
  type WebSearchRequest,
} from '@kb-chat/contracts';

/** One Firecrawl search: a kind, of one reference author or of none. */
export interface SearchGroup {
  readonly kind: WebSearchKind;
  readonly author: string | null;
  readonly query: string;
  /** Only these sites. */
  readonly domains?: readonly string[];
}

/** Firecrawl takes more, but a group never needs it: 30 sources are shared by the groups. */
const GROUP_LIMIT_MAX = 20;
/** Room for what is dropped: not an item page, repeated, or on an audio or video site. */
const GROUP_LIMIT_ROOM = 3;

const DOMAINS: Record<WebSearchKind, readonly string[] | undefined> = {
  text: undefined,
  audio: WEB_AUDIO_HOSTS,
  video: WEB_VIDEO_HOSTS,
};

/**
 * The subject, with the author's name in double quotes: the name's own quotes go, and so do
 * the subject's then (one left open would swallow the name). Cut to what Firecrawl takes.
 */
export function queryOf(subject: string, author: string | null): string {
  if (author === null) return subject;
  const name = ` "${withoutQuotes(author)}"`;
  const room = WEB_SEARCH_QUERY.max - name.length;
  return `${withoutQuotes(subject).slice(0, room).trimEnd()}${name}`.trim();
}

/** One search per kind, or per kind and author: every kind of an author before the next one. */
export function groupsOf(request: WebSearchRequest): SearchGroup[] {
  const authors = request.authors.length > 0 ? request.authors : [null];
  return authors.flatMap((author) =>
    request.kinds.map((kind) => ({
      kind,
      author,
      query: queryOf(request.query, author),
      ...(DOMAINS[kind] && { domains: DOMAINS[kind] }),
    })),
  );
}

/** What each search asks for: its share of the sources wanted, and room for what is dropped. */
export const groupLimit = (sources: number, groups: number): number =>
  Math.min(GROUP_LIMIT_MAX, Math.ceil(sources / groups) + GROUP_LIMIT_ROOM);
