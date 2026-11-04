import {
  MEDIA_BOOKMARKS_PER_MEDIA,
  type CreateMediaBookmarkRequest,
  type MediaBookmark,
  type MediaItem,
  type MyMediaBookmark,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type {
  BookmarkStorePort,
  BookmarkWithMedia,
  LeftTrack,
} from '../../ports/bookmark-store.js';
import type { MediaActor, MediaService } from './media-service.js';

export interface BookmarkServiceDeps {
  readonly bookmarks: BookmarkStorePort;
  /** Who sees which media (404 otherwise), with its length. */
  readonly media: MediaService;
  readonly now?: () => Date;
}

const unknownBookmark = () =>
  new AppError('MEDIA_NOT_FOUND', 'Unknown bookmark');

/** A bookmark as the contract shows it (no owner). */
const asBookmark = (stored: MediaBookmark): MediaBookmark => ({
  id: stored.id,
  mediaId: stored.mediaId,
  positionMs: stored.positionMs,
  note: stored.note,
  createdAt: stored.createdAt,
  updatedAt: stored.updatedAt,
});

/** A bookmark of "Meus marcadores" (no collection: it only filters). */
const asMine = (stored: BookmarkWithMedia): MyMediaBookmark => ({
  ...asBookmark(stored),
  mediaTitle: stored.mediaTitle,
  mediaDurationMs: stored.mediaDurationMs,
});

/** Where a new bookmark goes; `left`: the track it fell out of. */
interface BookmarkPlace {
  readonly media: MediaItem;
  readonly positionMs: number;
  readonly left?: LeftTrack;
}

/** One bookmark of one media. */
export interface BookmarkRef {
  readonly mediaId: string;
  readonly id: string;
}

/**
 * Each person's bookmarks (KBC-042): only their own, only in media they can see (BR-1,
 * BR-4); another person's bookmark answers as if it did not exist (404, AC-4).
 */
export class BookmarkService {
  constructor(private readonly deps: BookmarkServiceDeps) {}

  list(actor: MediaActor, mediaId: string): MediaBookmark[] {
    this.deps.media.get(actor, mediaId);
    return this.deps.bookmarks.bookmarksOf(actor.principal, mediaId);
  }

  /**
   * Creates the bookmark the client named. Sending the same one again gives it back as it
   * is (a retry never makes a second one); an id taken by anything else is a conflict.
   */
  create(
    actor: MediaActor,
    mediaId: string,
    request: CreateMediaBookmarkRequest,
  ): { readonly bookmark: MediaBookmark; readonly created: boolean } {
    const item = this.deps.media.get(actor, mediaId);
    const existing = this.deps.bookmarks.bookmark(request.id);
    if (existing) {
      // Another person's (or another media's): as if it did not exist (BR-1).
      const here = [mediaId, item.parent?.id];
      if (
        existing.principal !== actor.principal ||
        !here.includes(existing.mediaId)
      )
        throw unknownBookmark();
      return { bookmark: asBookmark(existing), created: false };
    }
    const place = this.placeOf(actor, item, request);
    this.assertCreatable(actor, place.media, place.positionMs);
    const now = this.now().toISOString();
    const bookmark: MediaBookmark = {
      id: request.id,
      mediaId: place.media.id,
      positionMs: place.positionMs,
      note: request.note ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.bookmarks.addBookmark({
      principal: actor.principal,
      bookmark,
      ...(place.left ? { left: place.left } : {}),
    });
    return { bookmark, created: true };
  }

  /** On a cut already replaced, it lands where one made there would have gone (KBC-073 BR-4). */
  private placeOf(
    actor: MediaActor,
    item: MediaItem,
    request: CreateMediaBookmarkRequest,
  ): BookmarkPlace {
    const landing = this.deps.media.bookmarkLanding(item, request);
    if (landing.inTrack) return { media: item, positionMs: landing.positionMs };
    return {
      media: this.deps.media.get(actor, item.parent?.id ?? item.id),
      positionMs: landing.recordingMs,
      left: { mediaId: item.id, title: item.title },
    };
  }

  /** Within the media's length, and under the cap per person and media. */
  private assertCreatable(
    actor: MediaActor,
    item: Pick<MediaItem, 'id' | 'durationMs'>,
    positionMs: number,
  ): void {
    if (item.durationMs !== null && positionMs > item.durationMs)
      throw new AppError('VALIDATION_FAILED', 'The position is past the end', {
        details: { field: 'positionMs' },
      });
    if (
      this.deps.bookmarks.countOf(actor.principal, item.id) >=
      MEDIA_BOOKMARKS_PER_MEDIA
    )
      throw new AppError(
        'BOOKMARK_LIMIT',
        `At most ${MEDIA_BOOKMARKS_PER_MEDIA} bookmarks per media`,
        { details: { limit: MEDIA_BOOKMARKS_PER_MEDIA } },
      );
  }

  updateNote(
    actor: MediaActor,
    ref: BookmarkRef,
    note: string | null,
  ): MediaBookmark {
    this.deps.media.get(actor, ref.mediaId);
    const changed = this.deps.bookmarks.updateNote({
      principal: actor.principal,
      mediaId: ref.mediaId,
      id: ref.id,
      note,
      now: this.now(),
    });
    const saved = changed ? this.deps.bookmarks.bookmark(ref.id) : null;
    if (!saved) throw unknownBookmark();
    return asBookmark(saved);
  }

  remove(actor: MediaActor, ref: BookmarkRef): void {
    this.deps.media.get(actor, ref.mediaId);
    const removed = this.deps.bookmarks.deleteBookmark({
      principal: actor.principal,
      mediaId: ref.mediaId,
      id: ref.id,
    });
    if (!removed) throw unknownBookmark();
  }

  /** "Meus marcadores": every bookmark in a media the person still sees (FR-5, BR-4). */
  mine(actor: MediaActor): MyMediaBookmark[] {
    return this.deps.bookmarks
      .allOf(actor.principal)
      .filter((bookmark) => actor.canSee(bookmark.mediaTopic))
      .map(asMine);
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
}
