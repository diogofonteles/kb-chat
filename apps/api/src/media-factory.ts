import { join } from 'node:path';
import type { AppConfig } from './config.js';
import { FsMediaFiles } from './adapters/media/fs-media-files.js';
import { openMediaDatabase } from './adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from './adapters/sqlite/media-migrations.js';
import { SqliteMediaStore } from './adapters/sqlite/sqlite-media-store.js';
import type { MediaFilesPort } from './ports/media-files.js';
import type { MediaStorePort } from './ports/media-store.js';

/** The media library's adapters and the worker token (ADR 0022). */
export interface MediaDeps {
  readonly store: MediaStorePort;
  readonly files: MediaFilesPort;
  readonly workerToken: string;
}

/**
 * Opens the media library when KB_CHAT_MEDIA=on (FR-1): the directory must be writable and
 * every migration must apply, or the API does not start, with a message that says why.
 */
export async function createMedia(
  config: AppConfig,
): Promise<MediaDeps | undefined> {
  if (!config.KB_CHAT_MEDIA) return undefined;
  const dir = config.KB_CHAT_MEDIA_DIR;
  const workerToken = config.KB_CHAT_MEDIA_WORKER_TOKEN;
  if (!workerToken)
    throw new Error('KB_CHAT_MEDIA=on needs KB_CHAT_MEDIA_WORKER_TOKEN');
  const files = new FsMediaFiles(dir);
  await files.assertWritable().catch((err: unknown) => {
    throw new Error(
      `The media library cannot start: ${dir} is not writable (KB_CHAT_MEDIA=on)`,
      { cause: err },
    );
  });
  try {
    const db = openMediaDatabase(join(dir, 'media.db'), MEDIA_MIGRATIONS);
    return { store: new SqliteMediaStore(db), files, workerToken };
  } catch (err) {
    throw new Error(
      `The media library cannot start: the media database in ${dir} did not open or migrate`,
      { cause: err },
    );
  }
}
