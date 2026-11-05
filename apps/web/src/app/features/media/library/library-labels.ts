import {
  listeningStateOf,
  type LibraryFilters,
  type LibraryTrack,
  type LibrarySort,
  type ListeningState,
} from '@kb-chat/contracts';
import { formatClock, resumeFrom } from '@kb-chat/player-core';

/** The library's words (screens.md T16); every one in pt-BR through $localize. */

/** The chips name the group in the plural ("Não ouvidas"), the row says one ("Ouvida"). */
export const STATE_CHIP_LABELS: Record<ListeningState, () => string> = {
  unheard: () => $localize`:@@library.state.unheardChip:Não ouvidas`,
  'in-progress': () => $localize`:@@library.state.inProgressChip:Em andamento`,
  heard: () => $localize`:@@library.state.heardChip:Ouvidas`,
};

export const SORT_LABELS: Record<LibrarySort, () => string> = {
  'recently-played': () =>
    $localize`:@@library.sort.recentlyPlayed:Ouvidas recentemente`,
  'recently-added': () =>
    $localize`:@@library.sort.recentlyAdded:Adicionadas recentemente`,
  title: () => $localize`:@@library.sort.title:Título A–Z`,
  duration: () => $localize`:@@library.sort.duration:Duração`,
  author: () => $localize`:@@library.sort.author:Autor`,
};

/**
 * Where the person is, in words next to the row (T16): "Não ouvida" is left out (most of
 * the list), "Em andamento" comes with "Continuar de" and the bar, "Ouvida" with ✓.
 */
export function stateTextOf(item: LibraryTrack): string {
  const state = listeningStateOf(item);
  if (state === 'heard') return $localize`:@@library.state.heard:✓ Ouvida`;
  if (state === 'in-progress')
    return $localize`:@@library.state.inProgress:Em andamento`;
  return '';
}

/** "Continuar de 23:10" for a ready media heard in part. */
export function resumeTextOf(item: LibraryTrack): string {
  const at =
    item.status === 'ready'
      ? resumeFrom(item.positionMs, item.durationMs)
      : null;
  return at === null
    ? ''
    : $localize`:@@media.resumeFrom:Continuar de ${formatClock(at)}:time:`;
}

/** The share already heard, for the thin bar (the text says it too). */
export const percentOf = (item: LibraryTrack): number =>
  item.durationMs
    ? Math.min(100, (item.positionMs / item.durationMs) * 100)
    : 0;

/** "42 mídias · 31 h" (or "· 45 min"): what "Todas" holds now, read aloud on change. */
export function countTextOf(total: number, totalMs: number): string {
  const count =
    total === 1
      ? $localize`:@@library.count.one:1 mídia`
      : $localize`:@@library.count.many:${total}:count: mídias`;
  if (totalMs === 0) return count;
  const minutes = Math.round(totalMs / 60_000);
  const length =
    minutes >= 60
      ? $localize`:@@media.summary.hours:${Math.round(minutes / 60)}:hours: h`
      : $localize`:@@media.summary.minutes:${Math.max(1, minutes)}:minutes: min`;
  return `${count} · ${length}`;
}

/** "3 resultados" (KBC-096); past the cap, "Mais de 200 resultados". */
export function resultCountOf(total: number, capped: boolean): string {
  if (capped)
    return $localize`:@@library.results.capped:Mais de ${total}:count: resultados`;
  return total === 1
    ? $localize`:@@library.results.one:1 resultado`
    : $localize`:@@library.results.many:${total}:count: resultados`;
}

/** "há 2 dias" next to a recently played media; "agora há pouco" under a minute. */
export function playedAgoOf(
  playedAt: string,
  now: Date,
  locale: string,
): string {
  const seconds = Math.round((Date.parse(playedAt) - now.getTime()) / 1000);
  if (seconds > -60) return $localize`:@@library.justNow:agora há pouco`;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const units: readonly [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  const [unit, size] = units.find(
    ([, length]) => Math.abs(seconds) >= length,
  ) ?? ['minute', 60];
  return format.format(Math.round(seconds / size), unit);
}

/** The generated cover's letters: the first two words' initials ("Palestra de 1998" → "P1"). */
export function initialsOf(title: string): string {
  const words = title
    .split(/\s+/)
    .filter((word) => /^[\p{L}\p{N}]/u.test(word) && word.length > 2);
  const picked = (words.length > 0 ? words : [title]).slice(0, 2);
  return picked
    .map((word) => word.charAt(0))
    .join('')
    .toLocaleUpperCase('pt-BR');
}

/** COVER_TONES tones, one per collection (the same collection, the same tone). */
export const COVER_TONES = 4;

export function coverToneOf(topic: string): number {
  let hash = 0;
  for (const char of topic) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % COVER_TONES;
}

/** How many filters are on (for "Limpar filtros"). */
export const activeFiltersOf = (filters: LibraryFilters): number =>
  filters.states.length +
  filters.authors.length +
  (filters.topic ? 1 : 0) +
  (filters.subject ? 1 : 0);

/** The list with the value added or taken out (a chip pressed). */
export function toggled<T>(values: readonly T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((one) => one !== value)
    : [...values, value];
}

/**
 * What a control changed, applied by the page to the filters it holds now: two quick
 * changes in a row never lose the first (the control's copy may not be updated yet).
 */
export type FilterChange =
  | { readonly kind: 'toggle-state'; readonly state: ListeningState }
  /** An author's id, NO_AUTHOR for "Outros autores", null for every author. */
  | { readonly kind: 'author'; readonly author: string | null }
  | { readonly kind: 'topic'; readonly topic: string | null }
  /** A subject's key (KBC-070), null for every subject. */
  | { readonly kind: 'subject'; readonly subject: string | null }
  | { readonly kind: 'clear' };

export const NO_FILTERS: LibraryFilters = {
  states: [],
  authors: [],
  topic: null,
  subject: null,
};

const FILTER_CHANGES: {
  [K in FilterChange['kind']]: (
    filters: LibraryFilters,
    change: Extract<FilterChange, { kind: K }>,
  ) => LibraryFilters;
} = {
  'toggle-state': (filters, change) => ({
    ...filters,
    states: toggled(filters.states, change.state),
  }),
  author: (filters, change) => ({
    ...filters,
    authors: change.author ? [change.author] : [],
  }),
  topic: (filters, change) => ({ ...filters, topic: change.topic }),
  subject: (filters, change) => ({ ...filters, subject: change.subject }),
  clear: () => NO_FILTERS,
};

export function applyFilterChange(
  filters: LibraryFilters,
  change: FilterChange,
): LibraryFilters {
  const apply = FILTER_CHANGES[change.kind] as (
    filters: LibraryFilters,
    change: FilterChange,
  ) => LibraryFilters;
  return apply(filters, change);
}
