import type { DatabaseSync } from 'node:sqlite';
import type { MediaBookmark } from '@kb-chat/contracts';
import type {
  BookmarkStorePort,
  BookmarkWithMedia,
} from '../../ports/bookmark-store.js';

type Row = Record<string, unknown>;

const COLUMNS =
  'b.id, b.media_id, b.position_ms, b.note, b.created_at, b.updated_at';

function toBookmark(row: Row): MediaBookmark {
  return {
    id: String(row['id']),
    mediaId: String(row['media_id']),
    positionMs: Number(row['position_ms']),
    note: row['note'] === null ? null : String(row['note']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

/** Bookmarks in the media database (KBC-042, migration 4). */
export class SqliteBookmarkStore implements BookmarkStorePort {
  constructor(private readonly db: DatabaseSync) {}

  bookmark(id: string): (MediaBookmark & { principal: string }) | null {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS}, b.principal FROM media_bookmarks b WHERE b.id = ?`,
      )
      .get(id);
    return row
      ? { ...toBookmark(row), principal: String(row['principal']) }
      : null;
  }

  bookmarksOf(principal: string, mediaId: string): MediaBookmark[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM media_bookmarks b
         WHERE b.principal = ? AND b.media_id = ?
         ORDER BY b.position_ms, b.created_at, b.rowid`,
      )
      .all(principal, mediaId)
      .map(toBookmark);
  }

  countOf(principal: string, mediaId: string): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM media_bookmarks WHERE principal = ? AND media_id = ?',
      )
      .get(principal, mediaId);
    return Number(row?.['n'] ?? 0);
  }

  allOf(principal: string): BookmarkWithMedia[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS}, m.title, m.topic, m.duration_ms
         FROM media_bookmarks b JOIN media m ON m.id = b.media_id
         WHERE b.principal = ?
         ORDER BY b.created_at DESC, b.rowid DESC`,
      )
      .all(principal)
      .map((row) => ({
        ...toBookmark(row),
        mediaTitle: String(row['title']),
        mediaTopic: String(row['topic']),
        mediaDurationMs:
          row['duration_ms'] === null ? null : Number(row['duration_ms']),
      }));
  }

  addBookmark(input: { principal: string; bookmark: MediaBookmark }): void {
    const { bookmark } = input;
    this.db
      .prepare(
        `INSERT INTO media_bookmarks
           (id, principal, media_id, position_ms, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        bookmark.id,
        input.principal,
        bookmark.mediaId,
        bookmark.positionMs,
        bookmark.note,
        bookmark.createdAt,
        bookmark.updatedAt,
      );
  }

  updateNote(input: {
    principal: string;
    mediaId: string;
    id: string;
    note: string | null;
    now: Date;
  }): boolean {
    const result = this.db
      .prepare(
        `UPDATE media_bookmarks SET note = ?, updated_at = ?
         WHERE id = ? AND principal = ? AND media_id = ?`,
      )
      .run(
        input.note,
        input.now.toISOString(),
        input.id,
        input.principal,
        input.mediaId,
      );
    return Number(result.changes) > 0;
  }

  deleteBookmark(input: {
    principal: string;
    mediaId: string;
    id: string;
  }): boolean {
    const result = this.db
      .prepare(
        'DELETE FROM media_bookmarks WHERE id = ? AND principal = ? AND media_id = ?',
      )
      .run(input.id, input.principal, input.mediaId);
    return Number(result.changes) > 0;
  }
}
