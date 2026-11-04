import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  DEFAULT_LIBRARY_PREFERENCES,
  listeningPreferencesSchema,
  type ListeningPreferences,
} from '@kb-chat/contracts';
import type {
  ListeningMark,
  ListeningProgress,
  ListeningStorePort,
  SavedProgress,
} from '../../ports/listening-store.js';
import { inTransaction } from './media-database.js';

type Row = Record<string, SQLOutputValue>;

const nullableText = (value: SQLOutputValue | undefined): string | null =>
  value === null || value === undefined ? null : String(value);

function toSavedProgress(row: Row): SavedProgress {
  return {
    positionMs: Number(row['position_ms']),
    completedAt: nullableText(row['completed_at']),
    updatedAt: String(row['updated_at']),
    playedAt: nullableText(row['played_at']),
  };
}

/** The player's (KBC-041, KBC-043, KBC-044) and the library's (KBC-051) choices. */
const SAVE_PREFERENCES = `INSERT INTO media_preferences
    (principal, speed, show_remaining, skip_back_sec, skip_forward_sec, skip_silences,
     library_sort, library_view, library_filters, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (principal) DO UPDATE SET speed = excluded.speed,
    show_remaining = excluded.show_remaining, skip_back_sec = excluded.skip_back_sec,
    skip_forward_sec = excluded.skip_forward_sec, skip_silences = excluded.skip_silences,
    library_sort = excluded.library_sort, library_view = excluded.library_view,
    library_filters = excluded.library_filters, updated_at = excluded.updated_at`;

const PROGRESS_COLUMNS =
  'media_id, position_ms, completed_at, updated_at, played_at';

/**
 * Preferences and positions in the media database (KBC-041, migration 2), with the
 * library's choices and "Limpar recentes" (KBC-051, migration 7).
 */
export class SqliteListeningStore implements ListeningStorePort {
  constructor(private readonly db: DatabaseSync) {}

  preferencesOf(principal: string): ListeningPreferences | null {
    const row = this.db
      .prepare(
        `SELECT speed, show_remaining, skip_back_sec, skip_forward_sec, skip_silences,
           library_sort, library_view, library_filters
         FROM media_preferences WHERE principal = ?`,
      )
      .get(principal);
    // Read back through the contract: a bad row fails loudly instead of reaching a player.
    return row
      ? listeningPreferencesSchema.parse({
          speed: Number(row['speed']),
          showRemaining: Number(row['show_remaining']) === 1,
          skipBackSec: Number(row['skip_back_sec']),
          skipForwardSec: Number(row['skip_forward_sec']),
          skipSilences: Number(row['skip_silences']) === 1,
          ...libraryChoicesOf(row),
        })
      : null;
  }

  savePreferences(input: {
    principal: string;
    preferences: ListeningPreferences;
    now: Date;
  }): void {
    const { preferences } = input;
    this.db
      .prepare(SAVE_PREFERENCES)
      .run(
        input.principal,
        preferences.speed,
        preferences.showRemaining ? 1 : 0,
        preferences.skipBackSec,
        preferences.skipForwardSec,
        preferences.skipSilences ? 1 : 0,
        preferences.librarySort,
        preferences.libraryView,
        JSON.stringify(preferences.libraryFilters),
        input.now.toISOString(),
      );
  }

  progressOf(
    principal: string,
    mediaIds: readonly string[],
  ): ReadonlyMap<string, SavedProgress> {
    const found = new Map<string, SavedProgress>();
    if (mediaIds.length === 0) return found;
    const marks = mediaIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT ${PROGRESS_COLUMNS} FROM media_progress
         WHERE principal = ? AND media_id IN (${marks})`,
      )
      .all(principal, ...mediaIds);
    for (const row of rows)
      found.set(String(row['media_id']), toSavedProgress(row));
    return found;
  }

  allProgressOf(principal: string): ReadonlyMap<string, SavedProgress> {
    const rows = this.db
      .prepare(
        `SELECT ${PROGRESS_COLUMNS} FROM media_progress WHERE principal = ?`,
      )
      .all(principal);
    return new Map(
      rows.map((row) => [String(row['media_id']), toSavedProgress(row)]),
    );
  }

  recentsClearedAt(principal: string): string | null {
    const row = this.db
      .prepare(
        'SELECT recents_cleared_at FROM media_library_state WHERE principal = ?',
      )
      .get(principal);
    return row ? String(row['recents_cleared_at']) : null;
  }

  clearRecents(input: { principal: string; now: Date }): void {
    this.db
      .prepare(
        `INSERT INTO media_library_state (principal, recents_cleared_at) VALUES (?, ?)
         ON CONFLICT (principal) DO UPDATE SET recents_cleared_at = excluded.recents_cleared_at`,
      )
      .run(input.principal, input.now.toISOString());
  }

  saveProgress(input: {
    principal: string;
    mediaId: string;
    progress: ListeningProgress;
    now: Date;
    played: boolean;
  }): void {
    const at = input.now.toISOString();
    // A mark keeps the last play time (COALESCE with the stored one).
    this.db
      .prepare(
        `INSERT INTO media_progress
           (principal, media_id, position_ms, completed_at, updated_at, played_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (principal, media_id) DO UPDATE SET position_ms = excluded.position_ms,
           completed_at = excluded.completed_at, updated_at = excluded.updated_at,
           played_at = COALESCE(excluded.played_at, media_progress.played_at)`,
      )
      .run(
        input.principal,
        input.mediaId,
        input.progress.positionMs,
        input.progress.completedAt,
        at,
        input.played ? at : null,
      );
  }

  markMany(input: { principal: string; marks: readonly ListeningMark[] }): void {
    inTransaction(this.db, () => {
      for (const mark of input.marks)
        this.saveProgress({
          principal: input.principal,
          ...mark,
          played: false,
        });
    });
  }
}

/** The library's columns; null (never chosen) reads as the default (KBC-051 BR-7). */
function libraryChoicesOf(row: Row) {
  const filters = nullableText(row['library_filters']);
  return {
    librarySort: row['library_sort'] ?? DEFAULT_LIBRARY_PREFERENCES.librarySort,
    libraryView: row['library_view'] ?? DEFAULT_LIBRARY_PREFERENCES.libraryView,
    libraryFilters:
      filters === null
        ? DEFAULT_LIBRARY_PREFERENCES.libraryFilters
        : (JSON.parse(filters) as unknown),
  };
}
