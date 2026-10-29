import {
  MEDIA_BOOKMARKS_PER_MEDIA,
  type CreateMediaBookmarkRequest,
  type MediaBookmark,
  type MyMediaBookmark,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { BookmarkStorePort } from '../../ports/bookmark-store.js';
import type { MediaActor, MediaService } from './media-service.js';

export interface BookmarkServiceDeps {
  readonly bookmarks: BookmarkStorePort;
  /** Who sees which media (404 otherwise), with its length. */
  readonly media: MediaService;
  readonly now?: () => Date;
}

const unknownBookmark = () =>
  new AppError('MEDIA_NOT_FOUND', 'Unknown bookmark');

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
      if (
        existing.principal !== actor.principal ||
        existing.mediaId !== mediaId
      )
        throw new AppError('MEDIA_CONFLICT', 'This bookmark id is taken');
      const { principal: _owner, ...bookmark } = existing;
      return { bookmark, created: false };
    }
    if (item.durationMs !== null && request.positionMs > item.durationMs)
      throw new AppError('VALIDATION_FAILED', 'The position is past the end', {
        details: { field: 'positionMs' },
      });
    if (
      this.deps.bookmarks.countOf(actor.principal, mediaId) >=
      MEDIA_BOOKMARKS_PER_MEDIA
    )
      throw new AppError(
        'MEDIA_CONFLICT',
        `At most ${MEDIA_BOOKMARKS_PER_MEDIA} bookmarks per media`,
        { details: { limit: MEDIA_BOOKMARKS_PER_MEDIA } },
      );
    const now = this.now().toISOString();
    const bookmark: MediaBookmark = {
      id: request.id,
      mediaId,
      positionMs: request.positionMs,
      note: request.note ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.bookmarks.addBookmark({ principal: actor.principal, bookmark });
    return { bookmark, created: true };
  }

  updateNote(
    actor: MediaActor,
    mediaId: string,
    id: string,
    note: string | null,
  ): MediaBookmark {
    this.deps.media.get(actor, mediaId);
    const changed = this.deps.bookmarks.updateNote({
      principal: actor.principal,
      mediaId,
      id,
      note,
      now: this.now(),
    });
    const saved = changed ? this.deps.bookmarks.bookmark(id) : null;
    if (!saved) throw unknownBookmark();
    const { principal: _owner, ...bookmark } = saved;
    return bookmark;
  }

  remove(actor: MediaActor, mediaId: string, id: string): void {
    this.deps.media.get(actor, mediaId);
    const removed = this.deps.bookmarks.deleteBookmark({
      principal: actor.principal,
      mediaId,
      id,
    });
    if (!removed) throw unknownBookmark();
  }

  /** "Meus marcadores": every bookmark in a media the person still sees (FR-5, BR-4). */
  mine(actor: MediaActor): MyMediaBookmark[] {
    return this.deps.bookmarks
      .allOf(actor.principal)
      .filter((bookmark) => actor.canSee(bookmark.mediaTopic))
      .map(({ mediaTopic: _topic, ...bookmark }) => bookmark);
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
}
