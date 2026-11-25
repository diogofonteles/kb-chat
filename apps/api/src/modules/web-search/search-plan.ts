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

/** Where an audio or a video is looked for once its own words are over, in turns. */
const SITES: Record<WebSearchKind, readonly (string | undefined)[]> = {
  text: [undefined],
  audio: [PODCASTS, SOUNDCLOUD],
  video: [YOUTUBE],
};

/** How the kind is asked for in this round: its own words first, then what was found gives. */
function wordingOf(
  kind: WebSearchKind,
  round: number,
  found: string | null,
): Wording | null {
  const own = WORDINGS[kind][round];
  if (own) return own;
  if (found === null) return null;
  const sites = SITES[kind];
  const site = sites[round % sites.length];
  return { word: found, ...(site !== undefined && { site }) };
}

/** Every kind still has words of its own in this round: none needs what was found. */
export const hasOwnWords = (
  kinds: readonly WebSearchKind[],
  round: number,
): boolean => kinds.every((kind) => round < WORDINGS[kind].length);

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
 * Past its own words a kind is asked for with one taken from what was found (`found`): there
 * is no last round while new things come. None when there is no word left.
 */
export function groupsOf(
  request: Pick<WebSearchRequest, 'query' | 'kinds' | 'authors'>,
  round: number,
  found: string | null = null,
): SearchGroup[] {
  const authors = request.authors.length > 0 ? request.authors : [null];
  return authors.flatMap((author) =>
    request.kinds.flatMap((kind) => {
      const wording = wordingOf(kind, round, found);
      if (!wording) return [];
      const query = queryOf(request.query, author, wording.word);
      const domains = wording.site && { domains: [wording.site] };
      return [{ kind, author, query, ...domains }];
    }),
  );
}
