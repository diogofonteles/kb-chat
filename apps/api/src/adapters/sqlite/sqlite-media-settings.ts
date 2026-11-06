import type { DatabaseSync } from 'node:sqlite';
import type {
  MediaSettingsPort,
  StoredMediaSetting,
} from '../../ports/media-settings.js';

/** The media library's settings table (KBC-037). */
export class SqliteMediaSettings implements MediaSettingsPort {
  constructor(private readonly db: DatabaseSync) {}

  get(key: string): StoredMediaSetting | null {
    const row = this.db
      .prepare(
        'SELECT value, updated_by, updated_at FROM media_settings WHERE key = ?',
      )
      .get(key);
    if (!row) return null;
    return {
      value: String(row['value']),
      updatedBy: String(row['updated_by']),
      updatedAt: String(row['updated_at']),
    };
  }

  set(input: { key: string; value: string; by: string; now: Date }): void {
    this.db
      .prepare(
        `INSERT INTO media_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(input.key, input.value, input.by, input.now.toISOString());
  }
}
