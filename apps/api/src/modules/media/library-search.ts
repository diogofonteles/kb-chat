import {
  LIBRARY_SEARCH_MAX,
  type HitSubject,
  type LibraryHit,
  type LibraryItem,
  type LibraryMatch,
  type LibrarySearch,
  type LibrarySearchQuery,
  type LibraryTrack,
} from '@kb-chat/contracts';
import type {
  MediaSegmentMatch,
  SpokenPlace,
  TrackLinksPort,
} from '../../ports/media-search.js';
import { excerptOf, termsOf, unmark } from '../search/index.js';
import { holdsWords, pageOf, titleWordsOf } from './library-query.js';

/** One search over what the person may be told about. */
export interface LibrarySearchInput {
  /** What the filters leave. */
  readonly candidates: readonly LibraryItem[];
  /** Everything the person sees, to know each recording's tracks. */
  readonly entries: readonly LibraryTrack[];
  /** Each track's subjects; null for who does not see them. */
  readonly subjects: ReadonlyMap<string, readonly HitSubject[]> | null;
  readonly query: LibrarySearchQuery;
  /** Absent for who has no `search`: no transcript is touched (R4). */
  readonly speech?: Pick<TrackLinksPort, 'spokenAmong' | 'passagesAt'>;
  readonly about?: Pick<TrackLinksPort, 'tracksAbout'>;
  readonly tracks: boolean;
}

/** One result before its passage is read. */
interface Found {
  readonly item: LibraryItem;
  readonly match: LibraryMatch;
  readonly place: number | null;
}

/** A published media can be heard, so what it says can be shown. */
const canSpeak = (item: LibraryItem): boolean =>
  item.status === 'ready' && !item.archived;

const countTracks = (
  entries: readonly LibraryTrack[],
): ReadonlyMap<string, number> => {
  const totals = new Map<string, number>();
  for (const { parent } of entries)
    if (parent) totals.set(parent.id, (totals.get(parent.id) ?? 0) + 1);
  return totals;
};

/**
 * R3: a track holds its recording's author, so "by author" would list the whole album: a track
 * answers for its own title, or for an author that is not the recording's.
 */
function byTitle(input: LibrarySearchInput): readonly LibraryItem[] {
  const { candidates, entries, query } = input;
  const authors = new Map(entries.map((one) => [one.id, one.author?.slug]));
  return candidates.filter((item) => {
    const own =
      !item.parent || authors.get(item.parent.id) !== item.author?.slug;
    return holdsWords(own ? titleWordsOf(item) : item.title, query.q);
  });
}

/** An accepted subject's name, or the track's title and summary. */
function bySubject(input: LibrarySearchInput): readonly LibraryItem[] {
  const { candidates, subjects, query, about } = input;
  if (!subjects) return [];
  const told = about?.tracksAbout(termsOf(query.q)) ?? new Set<string>();
  return candidates.filter(
    (item) =>
      told.has(item.id) ||
      subjects.get(item.id)?.some((one) => holdsWords(one.name, query.q)),
  );
}

/** Tracks and undivided audio first: a divided recording's check costs the most. */
function speakersFirst(
  items: readonly LibraryItem[],
  totals: ReadonlyMap<string, number>,
): string[] {
  const divided = (item: LibraryItem) => Number(totals.has(item.id));
  return [...items]
    .filter(canSpeak)
    .sort((a, b) => divided(a) - divided(b))
    .map((item) => item.id);
}

/** The places where the candidates say the words. */
function spoken(
  input: LibrarySearchInput,
  totals: ReadonlyMap<string, number>,
): { readonly places: readonly SpokenPlace[]; readonly more: boolean } {
  const { speech, candidates, query, tracks } = input;
  if (!speech) return { places: [], more: false };
  return speech.spokenAmong({
    terms: termsOf(query.q),
    ids: speakersFirst(candidates, totals),
    tracks,
    limit: LIBRARY_SEARCH_MAX,
  });
}

/** R2: speech, then title or author, then subject; each media once. */
function merged(
  input: LibrarySearchInput,
  places: readonly SpokenPlace[],
): readonly Found[] {
  const byId = new Map(input.candidates.map((item) => [item.id, item]));
  const found = new Map<string, Found>();
  for (const { mediaId, place } of places) {
    const item = byId.get(mediaId);
    if (item) found.set(mediaId, { item, match: 'speech', place });
  }
  const add = (items: readonly LibraryItem[], match: LibraryMatch) => {
    for (const item of items)
      if (!found.has(item.id)) found.set(item.id, { item, match, place: null });
  };
  add(byTitle(input), 'title');
  add(bySubject(input), 'subject');
  return [...found.values()];
}

/** What the page shows of each passage: marked, and short enough for a phone. */
function passagesOf(
  page: readonly Found[],
  input: LibrarySearchInput,
): ReadonlyMap<string, MediaSegmentMatch> {
  const places = page.flatMap((one) => one.place ?? []);
  const read = input.speech?.passagesAt(termsOf(input.query.q), places) ?? [];
  return new Map(read.map((match) => [match.mediaId, match]));
}

function toHit(
  { item, match }: Found,
  known: {
    readonly passage: MediaSegmentMatch | undefined;
    readonly totals: ReadonlyMap<string, number>;
  },
): LibraryHit {
  const { passage, totals } = known;
  return {
    item,
    trackCount: totals.get(item.id) ?? 0,
    match,
    passage: passage
      ? {
          ...excerptOf(unmark(passage.marked)),
          startMs: passage.startMs,
          endMs: passage.endMs,
          confidence: passage.confidence,
        }
      : null,
  };
}

/**
 * The library's search (KBC-096): one row per track, or per audio with no track holding the
 * match. Only the page on screen reads its passages, so "Mostrar mais" costs what the first did.
 */
export function searchLibrary(input: LibrarySearchInput): LibrarySearch {
  const totals = countTracks(input.entries);
  const { places, more } = spoken(input, totals);
  const all = merged(input, places);
  const reached = all.slice(0, LIBRARY_SEARCH_MAX);
  const { items: shown, nextCursor } = pageOf(reached, input.query.cursor);
  const passages = passagesOf(shown, input);
  return {
    items: shown.map((one) =>
      toHit(one, { passage: passages.get(one.item.id), totals }),
    ),
    nextCursor,
    total: reached.length,
    capped: more || all.length > LIBRARY_SEARCH_MAX,
  };
}
