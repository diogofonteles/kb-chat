import {
  DEFAULT_LIBRARY_PREFERENCES,
  type Author,
  type HiddenSpan,
  type HitSubject,
  type LibraryHome,
  type LibraryItem,
  type LibraryPage,
  type LibraryQuery,
  type LibrarySearch,
  type LibrarySearchQuery,
  type LibraryTrack,
  type MarkPlayedRequest,
  type MarkPlayedResult,
  type TrackParent,
} from '@kb-chat/contracts';
import type {
  ListeningMark,
  ListeningStorePort,
} from '../../ports/listening-store.js';
import type { TrackLinksPort } from '../../ports/media-search.js';
import type { LibraryRecord, MediaStorePort } from '../../ports/media-store.js';
import {
  continueListening,
  facetsOf,
  filterLibrary,
  pageOf,
  recentlyPlayed,
  sortLibrary,
} from './library-query.js';
import { isPublished, searchLibrary } from './library-search.js';
import { nextSaveTime } from './listening-service.js';
import {
  NO_LEVELS,
  shownLevel,
  type MediaActor,
  type MediaLevels,
} from './media-service.js';
import { canEditMedia, hearsLevel, seesMedia } from './media-policy.js';
import { hiddenSpansOf } from './track-levels.js';
import { mediaAuthorOf, toMediaItem } from './to-media-item.js';
import type { Presence } from './transcriber-service.js';

export interface LibraryServiceDeps {
  readonly store: MediaStorePort;
  readonly listening: ListeningStorePort;
  /** The collection and its sub-collections (ADR 0028); default: itself. */
  readonly scopeOf?: (topic: string) => readonly string[];
  readonly presence?: () => Presence;
  /** One author of the collection's list (KBC-049, a sub-collection uses its parent's). */
  readonly authorOf: (topic: string, slug: string) => Author | null;
  /** Tracks' accepted subjects (KBC-070); absent, the library has no "Assunto". */
  readonly subjectsOf?: (
    tracks: readonly { readonly mediaId: string; readonly topic: string }[],
  ) => ReadonlyMap<string, readonly HitSubject[]>;
  /** The transcripts' index (KBC-096); absent, the search reads titles and subjects. */
  readonly speech?: Pick<TrackLinksPort, 'spokenAmong' | 'passagesAt'>;
  /** Tracks by title and summary (KBC-070), for who sees subjects. */
  readonly about?: Pick<TrackLinksPort, 'tracksAbout'>;
  /** The collections' scales: masters see each audio's level (KBC-105 AC-11). */
  readonly levels?: MediaLevels;
  readonly now?: () => Date;
}

/**
 * The media library (KBC-051): every media of every collection the person sees, with the
 * same rules as the stream (ADR 0022). A media not ready yet shows only to who sent it and
 * to masters (BR-2); nothing of a collection the person cannot see ever leaves (NFR-3).
 */
export class LibraryService {
  constructor(private readonly deps: LibraryServiceDeps) {}

  page(actor: MediaActor, query: LibraryQuery): LibraryPage {
    const entries = this.entriesOf(actor);
    const items = recordingsOf(entries);
    const subjects = this.subjectsAmong(actor, entries);
    const shown = linkedTracks(entries, subjects, query.subject) ?? items;
    const matching = sortLibrary(
      filterLibrary(shown, {
        states: query.state ?? [],
        authors: query.author ?? [],
        topics: this.scope(actor, query.topic),
      }),
      query.sort ?? DEFAULT_LIBRARY_PREFERENCES.librarySort,
    );
    return {
      ...pageOf(matching, query.cursor),
      total: matching.length,
      totalDurationMs: matching.reduce(
        (sum, item) => sum + (item.durationMs ?? 0),
        0,
      ),
      facets: {
        ...facetsOf(items),
        subjects: subjects ? distinctSubjects(subjects) : [],
      },
    };
  }

  /** KBC-096: the tracks and undivided audio that answer, under the filters in force. */
  search(actor: MediaActor, query: LibrarySearchQuery): LibrarySearch {
    const entries = this.entriesOf(actor);
    const subjects = this.subjectsAmong(actor, entries);
    const asEntries = entries.map((entry) => ({ ...entry, tracks: [] }));
    const candidates = filterLibrary(
      linkedTracks(entries, subjects, query.subject) ?? asEntries,
      {
        states: query.state ?? [],
        authors: query.author ?? [],
        topics: this.scope(actor, query.topic),
      },
    ).filter(isPublished);
    return searchLibrary({
      candidates,
      entries,
      subjects,
      query,
      speech: actor.searchesSpeech ? this.deps.speech : undefined,
      // A summary is derived from the speech: only for who may search it (R4).
      about: subjects && actor.searchesSpeech ? this.deps.about : undefined,
      tracks: actor.seesTracks ?? false,
      levelsByTopic: new Map(
        [...new Set(candidates.map((item) => item.topic))].map((topic) => [
          topic,
          actor.levelsIn(topic),
        ]),
      ),
    });
  }

  /** Each track's subjects; null for who does not see subjects and tracks (BR-3). */
  private subjectsAmong(
    actor: MediaActor,
    entries: readonly LibraryTrack[],
  ): ReadonlyMap<string, readonly HitSubject[]> | null {
    const { subjectsOf } = this.deps;
    if (!subjectsOf || !actor.seesTracks || !actor.seesSubjects) return null;
    return subjectsOf(
      entries
        .filter((entry) => entry.parent)
        .map((entry) => ({ mediaId: entry.id, topic: entry.topic })),
    );
  }

  home(actor: MediaActor, topic?: string): LibraryHome {
    const scope = this.scope(actor, topic);
    const items = this.entriesOf(actor)
      .filter((entry) => scope === null || scope.has(entry.topic))
      .map((entry) => ({ ...entry, tracks: [] }));
    const clearedAt = this.deps.listening.recentsClearedAt(actor.principal);
    return {
      continueListening: continueListening(items),
      recentlyPlayed: recentlyPlayed(items, clearedAt),
      recentsClearedAt: clearedAt,
    };
  }

  /** BR-4: positions, marks and bookmarks stay; only the list of recents empties. */
  clearRecents(actor: MediaActor): void {
    this.deps.listening.clearRecents({
      principal: actor.principal,
      now: this.now(),
    });
  }

  /**
   * BR-5: heard is what reaching 95% does (the time it was heard, the position back to 0);
   * not heard clears that time, also at 0. Media the person cannot play are skipped.
   */
  markPlayed(actor: MediaActor, request: MarkPlayedRequest): MarkPlayedResult {
    const playable = new Map(
      this.entriesOf(actor)
        .filter((item) => item.status === 'ready')
        .map((item) => [item.id, item]),
    );
    const chosen = [...new Set(request.ids)].flatMap((id) => {
      const item = playable.get(id);
      return item ? [item] : [];
    });
    const marks = chosen.map((item) => this.markOf(item, request.played));
    this.deps.listening.markMany({ principal: actor.principal, marks });
    return {
      applied: marks.map((mark) => mark.mediaId),
      marks: marks.map((mark) => ({
        id: mark.mediaId,
        completedAt: mark.progress.completedAt,
        positionUpdatedAt: mark.now.toISOString(),
      })),
    };
  }

  private markOf(item: LibraryTrack, played: boolean): ListeningMark {
    const now = nextSaveTime(item.positionUpdatedAt, this.now());
    const completedAt = played ? (item.completedAt ?? now.toISOString()) : null;
    return {
      mediaId: item.id,
      progress: { positionMs: 0, completedAt },
      now,
    };
  }

  /** The chosen collection with its sub-collections, if the person sees it; else none. */
  private scope(
    actor: MediaActor,
    topic: string | undefined,
  ): ReadonlySet<string> | null {
    if (topic === undefined) return null;
    if (!actor.canSee(topic)) return new Set();
    return new Set(this.deps.scopeOf?.(topic) ?? [topic]);
  }

  /** Every recording and track the person may see, each with their own position. */
  private entriesOf(actor: MediaActor): LibraryTrack[] {
    const progress = this.deps.listening.allProgressOf(actor.principal);
    const presence = this.deps.presence?.();
    const records = this.deps.store.listLibrary();
    const titles = new Map(records.map((one) => [one.id, one.title]));
    const totals = countTracks(records);
    const levels = this.deps.levels ?? NO_LEVELS;
    const hidden = hiddenByRecording(actor, records);
    return records
      .filter((record) => isVisible(actor, record))
      .map((record) => {
        const saved = progress.get(record.id);
        return {
          ...toMediaItem(record, actor.isMaster, {
            progress: saved,
            presence,
            author: mediaAuthorOf(record, this.deps.authorOf),
            canEdit: canEditMedia(actor, record),
            parent: parentOf(record, { titles, totals }),
            level: shownLevel(record, {
              scale: levels.scaleOf(record.topic),
              shows: actor.isMaster || canEditMedia(actor, record),
            }),
            hidden: hidden.get(record.id) ?? [],
          }),
          kind: record.kind,
          lastPlayedAt: saved?.playedAt ?? null,
        };
      });
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
}

/**
 * The chosen subject's tracks, as rows of their own (AC-7). Null when no subject applies:
 * none chosen, or one saved by who no longer sees subjects, ignored and kept (BR-3).
 */
function linkedTracks(
  entries: readonly LibraryTrack[],
  subjects: ReadonlyMap<string, readonly HitSubject[]> | null,
  chosen: string | undefined,
): LibraryItem[] | null {
  if (chosen === undefined || subjects === null) return null;
  return entries
    .filter((entry) => subjects.get(entry.id)?.some((s) => s.key === chosen))
    .map((entry) => ({ ...entry, tracks: [] }));
}

/** Each subject once, by name: what "Assunto" offers. */
function distinctSubjects(
  subjects: ReadonlyMap<string, readonly HitSubject[]>,
): HitSubject[] {
  const byKey = new Map(
    [...subjects.values()].flat().map((subject) => [subject.key, subject]),
  );
  return [...byKey.values()].sort((a, b) =>
    a.name.localeCompare(b.name, 'pt-BR'),
  );
}

/** How many tracks each recording has in force. */
function countTracks(records: readonly LibraryRecord[]) {
  const totals = new Map<string, number>();
  for (const { track } of records)
    if (track?.ordinal != null)
      totals.set(track.parentId, (totals.get(track.parentId) ?? 0) + 1);
  return totals;
}

function parentOf(
  record: LibraryRecord,
  known: {
    readonly titles: ReadonlyMap<string, string>;
    readonly totals: ReadonlyMap<string, number>;
  },
): TrackParent | null {
  if (!record.track) return null;
  const { parentId: id, startMs, endMs, ordinal } = record.track;
  const { version, fileVersion } = record.track;
  const title = known.titles.get(id) ?? record.title;
  return {
    id,
    title,
    startMs,
    endMs,
    ordinal,
    total: known.totals.get(id) ?? 0,
    version,
    fileVersion,
  };
}

/** The recordings, each with its tracks in order (FR-5). */
function recordingsOf(entries: readonly LibraryTrack[]): LibraryItem[] {
  const tracks = new Map<string, LibraryTrack[]>();
  for (const entry of entries)
    if (entry.parent)
      tracks.set(entry.parent.id, [
        ...(tracks.get(entry.parent.id) ?? []),
        entry,
      ]);
  const byOrdinal = (a: LibraryTrack, b: LibraryTrack) =>
    (a.parent?.ordinal ?? 0) - (b.parent?.ordinal ?? 0);
  return entries
    .filter((entry) => !entry.parent)
    .map((entry) => ({
      ...entry,
      tracks: (tracks.get(entry.id) ?? []).sort(byOrdinal),
    }));
}

/**
 * BR-2: a collection the person sees; not ready yet only for who sent it and masters. Only
 * audio for now: video comes with its own item (KBC-076). A track, for `media-tracks`, once
 * published and while it is in the edit (KBC-068 FR-1, FR-5, BR-5).
 */
function isVisible(actor: MediaActor, record: LibraryRecord): boolean {
  // KBC-105 BR-5: an audio above the person's level is not in the library at all.
  if (record.kind !== 'audio' || !seesMedia(actor, record)) return false;
  if (record.track)
    return (
      actor.seesTracks === true &&
      record.status === 'ready' &&
      record.archivedAt === null
    );
  return (
    record.status === 'ready' ||
    actor.isMaster ||
    record.ownerPrincipal === actor.principal
  );
}

/**
 * KBC-106 FR-2: per recording, the parts this person may not hear (its live tracks above
 * their level), from the rows the library read anyway.
 */
function hiddenByRecording(
  actor: MediaActor,
  records: readonly LibraryRecord[],
): ReadonlyMap<string, readonly HiddenSpan[]> {
  const tracks = new Map<string, LibraryRecord[]>();
  for (const record of records) {
    const { track } = record;
    if (!track || record.status !== 'ready' || record.archivedAt !== null)
      continue;
    if (actor.levelsIn(record.topic) === null) continue;
    tracks.set(track.parentId, [...(tracks.get(track.parentId) ?? []), record]);
  }
  const hidden = new Map<string, readonly HiddenSpan[]>();
  for (const [parentId, list] of tracks) {
    const spans = hiddenSpansOf(
      list.map((one) => ({
        mediaId: one.id,
        level: one.level,
        startMs: one.track?.startMs ?? 0,
        endMs: one.track?.endMs ?? 0,
      })),
      (level) => hearsLevel(actor, list[0]?.topic ?? '', level),
    );
    if (spans.length > 0) hidden.set(parentId, spans);
  }
  return hidden;
}
