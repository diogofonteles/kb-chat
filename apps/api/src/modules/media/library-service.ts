import {
  DEFAULT_LIBRARY_PREFERENCES,
  type LibraryHome,
  type LibraryItem,
  type LibraryPage,
  type LibraryQuery,
  type MarkPlayedRequest,
  type MarkPlayedResult,
} from '@kb-chat/contracts';
import type { ListeningStorePort } from '../../ports/listening-store.js';
import type { LibraryRecord, MediaStorePort } from '../../ports/media-store.js';
import {
  continueListening,
  facetsOf,
  filterLibrary,
  pageOf,
  recentlyPlayed,
  sortLibrary,
} from './library-query.js';
import { nextSaveTime } from './listening-service.js';
import type { MediaActor } from './media-service.js';
import { toMediaItem } from './to-media-item.js';
import type { Presence } from './transcriber-service.js';

export interface LibraryServiceDeps {
  readonly store: MediaStorePort;
  readonly listening: ListeningStorePort;
  /** The collection and its sub-collections (ADR 0028); default: itself. */
  readonly scopeOf?: (topic: string) => readonly string[];
  readonly presence?: () => Presence;
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
    const items = this.itemsOf(actor);
    const matching = sortLibrary(
      filterLibrary(items, {
        kinds: query.kind ?? [],
        states: query.state ?? [],
        authorships: query.authorship ?? [],
        topics: this.scope(actor, query.topic),
        query: query.q ?? '',
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
      facets: facetsOf(items),
    };
  }

  home(actor: MediaActor): LibraryHome {
    const items = this.itemsOf(actor);
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
      this.itemsOf(actor)
        .filter((item) => item.status === 'ready')
        .map((item) => [item.id, item]),
    );
    const applied = [...new Set(request.ids)].filter((id) => playable.has(id));
    for (const id of applied) {
      const item = playable.get(id);
      if (item) this.mark(actor, item, request.played);
    }
    return { applied };
  }

  private mark(actor: MediaActor, item: LibraryItem, played: boolean): void {
    const now = nextSaveTime(item.positionUpdatedAt, this.now());
    const completedAt = played ? (item.completedAt ?? now.toISOString()) : null;
    this.deps.listening.saveProgress({
      principal: actor.principal,
      mediaId: item.id,
      progress: { positionMs: 0, completedAt },
      now,
      played: false,
    });
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

  private itemsOf(actor: MediaActor): LibraryItem[] {
    const progress = this.deps.listening.allProgressOf(actor.principal);
    const presence = this.deps.presence?.();
    return this.deps.store
      .listLibrary()
      .filter((record) => isVisible(actor, record))
      .map((record) => {
        const saved = progress.get(record.id);
        return {
          ...toMediaItem(record, actor.isMaster, { progress: saved, presence }),
          kind: record.kind,
          lastPlayedAt: saved?.playedAt ?? null,
        };
      });
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
}

/** BR-2: a collection the person sees; not ready yet only for who sent it and masters. */
function isVisible(actor: MediaActor, record: LibraryRecord): boolean {
  if (!actor.canSee(record.topic)) return false;
  return (
    record.status === 'ready' ||
    actor.isMaster ||
    record.ownerPrincipal === actor.principal
  );
}
