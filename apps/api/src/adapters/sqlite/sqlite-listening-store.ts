import type { DatabaseSync } from 'node:sqlite';
import {
  mediaPreferencesSchema,
  type MediaPreferences,
} from '@kb-chat/contracts';
import type {
  ListeningProgress,
  ListeningStorePort,
  SavedProgress,
} from '../../ports/listening-store.js';

/** Preferences and positions in the media database (KBC-041, migration 2). */
export class SqliteListeningStore implements ListeningStorePort {
  constructor(private readonly db: DatabaseSync) {}

  preferencesOf(principal: string): MediaPreferences | null {
    const row = this.db
      .prepare(
        'SELECT speed, show_remaining FROM media_preferences WHERE principal = ?',
      )
      .get(principal);
    // Read back through the contract: a bad row fails loudly instead of reaching a player.
    return row
      ? mediaPreferencesSchema.parse({
          speed: Number(row['speed']),
          showRemaining: Number(row['show_remaining']) === 1,
        })
      : null;
  }

  savePreferences(input: {
    principal: string;
    preferences: MediaPreferences;
    now: Date;
  }): void {
    this.db
      .prepare(
        `INSERT INTO media_preferences (principal, speed, show_remaining, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (principal) DO UPDATE SET speed = excluded.speed,
           show_remaining = excluded.show_remaining, updated_at = excluded.updated_at`,
      )
      .run(
        input.principal,
        input.preferences.speed,
        input.preferences.showRemaining ? 1 : 0,
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
        `SELECT media_id, position_ms, completed_at, updated_at FROM media_progress
         WHERE principal = ? AND media_id IN (${marks})`,
      )
      .all(principal, ...mediaIds);
    for (const row of rows)
      found.set(String(row['media_id']), {
        positionMs: Number(row['position_ms']),
        completedAt:
          row['completed_at'] === null ? null : String(row['completed_at']),
        updatedAt: String(row['updated_at']),
      });
    return found;
  }

  saveProgress(input: {
    principal: string;
    mediaId: string;
    progress: ListeningProgress;
    now: Date;
  }): void {
    this.db
      .prepare(
        `INSERT INTO media_progress (principal, media_id, position_ms, completed_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (principal, media_id) DO UPDATE SET position_ms = excluded.position_ms,
           completed_at = excluded.completed_at, updated_at = excluded.updated_at`,
      )
      .run(
        input.principal,
        input.mediaId,
        input.progress.positionMs,
        input.progress.completedAt,
        input.now.toISOString(),
      );
  }
}
