import { z } from 'zod';
import { authorSchema } from './authors.js';
import {
  mediaIdSchema,
  mediaItemSchema,
  mediaPreferencesSchema,
  type MediaItem,
} from './media.js';
import { authorSlugSchema } from './slugs.js';
import { topicSlugSchema } from './topics.js';

/**
 * The media library (KBC-051, screens.md T16): every audio and video of the collections a
 * person sees, with "Continuar ouvindo", "Ouvidas recentemente", filters, sorting, a list
 * or grid view and "Marcar como ouvida".
 */

/**
 * Audio now. Video (KBC-035) and its library parts are for a later version (owner,
 * 2026-11-03): the kind is in the contract so they can arrive without a break.
 */
export const MEDIA_KINDS = ['audio', 'video'] as const;
export const mediaKindSchema = z.enum(MEDIA_KINDS);
export type MediaKind = z.infer<typeof mediaKindSchema>;

/** Where a person is in a media (BR-6): never heard, heard in part, or heard. */
export const LISTENING_STATES = ['unheard', 'in-progress', 'heard'] as const;
export const listeningStateSchema = z.enum(LISTENING_STATES);
export type ListeningState = z.infer<typeof listeningStateSchema>;

/** BR-6: "Ouvida" once marked or heard to 95%, even if played again afterwards. */
export function listeningStateOf(
  item: Pick<MediaItem, 'positionMs' | 'completedAt'>,
): ListeningState {
  if (item.completedAt !== null) return 'heard';
  return item.positionMs > 0 ? 'in-progress' : 'unheard';
}

/** The library's orders (T16 "Ordenar"); the first is the default. */
export const LIBRARY_SORTS = [
  'recently-played',
  'recently-added',
  'title',
  'duration',
  'author',
] as const;
export const librarySortSchema = z.enum(LIBRARY_SORTS);
export type LibrarySort = z.infer<typeof librarySortSchema>;

export const LIBRARY_VIEWS = ['list', 'grid'] as const;
export const libraryViewSchema = z.enum(LIBRARY_VIEWS);
export type LibraryView = z.infer<typeof libraryViewSchema>;

/** The "Autoria" choice for media with no author ("Outros autores", KBC-049). */
export const NO_AUTHOR = '-';
/** An author of a collection, or NO_AUTHOR. */
export const libraryAuthorSchema = z.union([
  authorSlugSchema,
  z.literal(NO_AUTHOR),
]);
/** The most authors one filter names. */
export const LIBRARY_AUTHORS_MAX = 20;

/**
 * The library's filters as kept in the account (BR-7): within a group the chips add up
 * (Não ouvidas or Em andamento), across groups they narrow (Em andamento and an author).
 */
export const libraryFiltersSchema = z.strictObject({
  states: z.array(listeningStateSchema).max(LISTENING_STATES.length),
  authors: z.array(libraryAuthorSchema).max(LIBRARY_AUTHORS_MAX),
  /** A collection, its sub-collections included (ADR 0028); null for all. */
  topic: topicSlugSchema.nullable(),
});
export type LibraryFilters = z.infer<typeof libraryFiltersSchema>;

export const NO_LIBRARY_FILTERS: LibraryFilters = {
  states: [],
  authors: [],
  topic: null,
};

/** Items per page of `GET /media/library` (FR-1). */
export const LIBRARY_PAGE_SIZE = 50;
/** "Continuar ouvindo" (BR-3) and "Ouvidas recentemente" (BR-4). */
export const CONTINUE_LISTENING_MAX = 10;
export const RECENTLY_PLAYED_MAX = 50;
/** The most media one "Marcar como ouvida" applies to (FR-3). */
export const MARK_PLAYED_MAX = 200;
/** The longest "Buscar na biblioteca". */
export const LIBRARY_QUERY_MAX = 200;

/** A comma-separated list in the query string (`state=unheard,heard`), each value checked. */
const csvOf = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .string()
    .max(200)
    .transform((value) => value.split(',').filter((part) => part !== ''))
    .pipe(z.array(item).max(10));

/** GET /api/v1/media/library: the filters, the search, the order and the page. */
export const libraryQuerySchema = z.strictObject({
  state: csvOf(listeningStateSchema).optional(),
  author: csvOf(libraryAuthorSchema).optional(),
  topic: topicSlugSchema.optional(),
  q: z.string().max(LIBRARY_QUERY_MAX).optional(),
  sort: librarySortSchema.optional(),
  cursor: z
    .string()
    .regex(/^[0-9]{1,6}$/)
    .optional(),
});
export type LibraryQuery = z.infer<typeof libraryQuerySchema>;

/** A media in the library: the item plus its kind and when the person last played it. */
export const libraryItemSchema = mediaItemSchema.extend({
  kind: mediaKindSchema,
  /** When the person's player last saved a position in it; null when never played. */
  lastPlayedAt: z.iso.datetime().nullable(),
});
export type LibraryItem = z.infer<typeof libraryItemSchema>;

/** What exists in the person's library, so a chip with nothing behind it is not shown. */
export const libraryFacetsSchema = z.object({
  states: z.array(listeningStateSchema),
  /** The authors with media in the library (KBC-049), each once. */
  authors: z.array(authorSchema),
  /** Some media have no author ("Outros autores"). */
  otherAuthors: z.boolean(),
  /** The collections holding the person's media. */
  topics: z.array(topicSlugSchema),
});
export type LibraryFacets = z.infer<typeof libraryFacetsSchema>;

export const libraryPageSchema = z.object({
  items: z.array(libraryItemSchema),
  /** The next page's cursor; null on the last page. */
  nextCursor: z.string().nullable(),
  /** How many media match, over every page, and their length together. */
  total: z.number().int().min(0),
  totalDurationMs: z.number().int().min(0),
  facets: libraryFacetsSchema,
});
export type LibraryPage = z.infer<typeof libraryPageSchema>;

/** GET /api/v1/media/library/home (FR-2). */
export const libraryHomeSchema = z.object({
  continueListening: z.array(libraryItemSchema).max(CONTINUE_LISTENING_MAX),
  recentlyPlayed: z.array(libraryItemSchema).max(RECENTLY_PLAYED_MAX),
  /** When the person last chose "Limpar recentes"; null when never. */
  recentsClearedAt: z.iso.datetime().nullable(),
});
export type LibraryHome = z.infer<typeof libraryHomeSchema>;

/** PUT /api/v1/media/played (FR-3). */
export const markPlayedRequestSchema = z.strictObject({
  ids: z.array(mediaIdSchema).min(1).max(MARK_PLAYED_MAX),
  played: z.boolean(),
});
export type MarkPlayedRequest = z.infer<typeof markPlayedRequestSchema>;

/** The media the change applied to; the ones the person does not see are left out. */
export const markPlayedResultSchema = z.object({
  applied: z.array(mediaIdSchema),
});
export type MarkPlayedResult = z.infer<typeof markPlayedResultSchema>;

/** The library's choices before any (BR-7): recently played, as a list, no filter. */
export const DEFAULT_LIBRARY_PREFERENCES = {
  librarySort: 'recently-played',
  libraryView: 'list',
  libraryFilters: NO_LIBRARY_FILTERS,
} as const satisfies {
  librarySort: LibrarySort;
  libraryView: LibraryView;
  libraryFilters: LibraryFilters;
};

/**
 * GET /api/v1/media/preferences (KBC-041 FR-1, KBC-051 FR-5): the player's choices and the
 * library's, for every device.
 */
export const listeningPreferencesSchema = mediaPreferencesSchema.extend({
  librarySort: librarySortSchema,
  libraryView: libraryViewSchema,
  libraryFilters: libraryFiltersSchema,
});
export type ListeningPreferences = z.infer<typeof listeningPreferencesSchema>;

/** The player's part of the answer (the library's fields left aside). */
export const playerPreferencesSchema = z.object(mediaPreferencesSchema.shape);

/**
 * PUT /api/v1/media/preferences: only what changed. The player and the library each send
 * their own fields, so neither overwrites a newer choice of the other.
 */
export const listeningPreferencesUpdateSchema = listeningPreferencesSchema
  .partial()
  .refine((update) => Object.keys(update).length > 0, {
    error: 'nothing to save',
  });
export type ListeningPreferencesUpdate = z.infer<
  typeof listeningPreferencesUpdateSchema
>;
