import {
  WEB_SEARCH_QUERY,
  withoutQuotes,
  type WebSearchKind,
  type WebSearchRequest,
} from '@kb-chat/contracts';

/** One Firecrawl search: a kind, of one reference author or of none, said in one way. */
export interface SearchGroup {
  readonly kind: WebSearchKind;
  readonly author: string | null;
  readonly query: string;
  /** Only this site. */
  readonly domains?: readonly string[];
}

/**
 * What one search asks for: the engine charges by tens, and past the first ten what comes is
 * hardly about the subject (measured on real searches). More comes from asking in other words.
 */
export const RESULTS_PER_SEARCH = 10;

/** One way of asking: a word beside the subject, and the one site it is asked of. */
interface Wording {
  readonly word: string;
  readonly site?: string;
}

const words = (...all: readonly string[]): Wording[] =>
  all.map((word) => ({ word }));
const on = (site: string, ...all: readonly string[]): Wording[] =>
  all.map((word) => ({ word, site }));

const YOUTUBE = 'youtube.com';
const VIMEO = 'vimeo.com';
const PODCASTS = 'podcasts.apple.com';
const SOUNDCLOUD = 'soundcloud.com';

/**
 * How each kind is asked for, round after round: the subject alone first. An audio or a video
 * is asked of one site at a time: asked of several at once the engine gives a fraction.
 */
const WORDINGS: Record<WebSearchKind, readonly Wording[]> = {
  text: words(
    '',
    'artigo',
    'ensinamentos',
    'o que é',
    'livro',
    'técnica',
    'estudo',
    'prática',
    'resumo',
    'história',
    'perguntas e respostas',
    'pdf',
  ),
  audio: [
    ...on(PODCASTS, ''),
    ...on(SOUNDCLOUD, ''),
    ...on(PODCASTS, 'podcast', 'entrevista', 'meditação'),
    ...on(SOUNDCLOUD, 'podcast', 'palestra', 'meditação'),
    ...on(PODCASTS, 'aula'),
    ...on(SOUNDCLOUD, 'audiolivro'),
  ],
  video: [
    ...on(YOUTUBE, '', 'aula', 'palestra', 'entrevista', 'curso', 'técnica'),
    ...on(VIMEO, ''),
    ...on(YOUTUBE, 'documentário', 'live', 'meditação', 'explicação', 'resumo'),
  ],
};

const oneLine = (parts: readonly string[]): string =>
  parts.filter((part) => part !== '').join(' ');

/**
 * The subject, the author's name and the word of this round, none in quotes: a name in quotes
 * finds nothing when it is spelled another way. Cut to what the engine takes, in the subject.
 */
export function queryOf(
  subject: string,
  author: string | null,
  word = '',
): string {
  const rest = oneLine([author === null ? '' : withoutQuotes(author), word]);
  const room = WEB_SEARCH_QUERY.max - rest.length - 1;
  return oneLine([subject.slice(0, room).trim(), rest]);
}

/**
 * The searches of one round: one per author and kind that still has another way to be asked.
 * None when every way was used: the request is exhausted.
 */
export function groupsOf(
  request: Pick<WebSearchRequest, 'query' | 'kinds' | 'authors'>,
  round: number,
): SearchGroup[] {
  const authors = request.authors.length > 0 ? request.authors : [null];
  return authors.flatMap((author) =>
    request.kinds.flatMap((kind) => {
      const wording = WORDINGS[kind][round];
      if (!wording) return [];
      const query = queryOf(request.query, author, wording.word);
      const domains = wording.site && { domains: [wording.site] };
      return [{ kind, author, query, ...domains }];
    }),
  );
}
