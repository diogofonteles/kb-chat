import { join } from 'node:path';
import type { AppConfig } from './config.js';
import { FsMediaFiles } from './adapters/media/fs-media-files.js';
import { openMediaDatabase } from './adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from './adapters/sqlite/media-migrations.js';
import { SqliteBookmarkStore } from './adapters/sqlite/sqlite-bookmark-store.js';
import { SqliteListeningStore } from './adapters/sqlite/sqlite-listening-store.js';
import { SqliteMediaSpendLedger } from './adapters/sqlite/sqlite-media-spend-ledger.js';
import { SqliteMediaSearch } from './adapters/sqlite/sqlite-media-search.js';
import { SqliteMediaStore } from './adapters/sqlite/sqlite-media-store.js';
import { SqliteTrackProposalStore } from './adapters/sqlite/sqlite-track-proposal-store.js';
import { SqliteSilenceStore } from './adapters/sqlite/sqlite-silence-store.js';
import { SqliteTranscriberStore } from './adapters/sqlite/sqlite-transcriber-store.js';
import { SqliteTranscriptStore } from './adapters/sqlite/sqlite-transcript-store.js';
import type { BookmarkStorePort } from './ports/bookmark-store.js';
import type { ListeningStorePort } from './ports/listening-store.js';
import type { MediaFilesPort } from './ports/media-files.js';
import type { MediaSpendLedgerPort } from './ports/media-spend-ledger.js';
import type { MediaSearchPort } from './ports/media-search.js';
import type { MediaStorePort } from './ports/media-store.js';
import type { TrackProposalStorePort } from './ports/track-proposal-store.js';
import type { SilenceStorePort } from './ports/silence-store.js';
import type { TranscriberStorePort } from './ports/transcriber-store.js';
import type { TranscriptStorePort } from './ports/transcript-store.js';

/** The media library's adapters and the worker token (ADR 0022). */
export interface MediaDeps {
  readonly store: MediaStorePort;
  /** Each person's preferences and positions, in the same database (KBC-041). */
  readonly listening: ListeningStorePort;
  /** Each person's bookmarks (KBC-042). */
  readonly bookmarks: BookmarkStorePort;
  /** Transcripts and the term list (KBC-036). */
  readonly transcripts: TranscriptStorePort;
  /** Paired transcribers (KBC-036). */
  readonly transcribers: TranscriberStorePort;
  /** The AI's proposal runs and draft tracks (KBC-067). */
  readonly trackProposals: TrackProposalStorePort;
  /** The media monthly spend ledger (ADR 0022 §7). */
  readonly spend: MediaSpendLedgerPort;
  /** The media AI's model and caps (KBC-067, ADR 0029). */
  readonly ai: {
    readonly model: string;
    readonly runCapUsd: number;
    readonly monthlyCapUsd: number;
  };
  /** Silence maps (KBC-044). */
  readonly silences: SilenceStorePort;
  /** The current transcripts' search index (KBC-039, ADR 0024). */
  readonly search: MediaSearchPort;
  readonly files: MediaFilesPort;
  readonly workerToken: string;
  /** Keys the transcriber token hashes (KB_CHAT_SECRETS_KEY, ADR 0017). */
  readonly tokenKey: Buffer;
  /** Items created per minute per client (MEDIA_CREATE_RATE_LIMIT). */
  readonly createPerMinute: number;
}

/**
 * Opens the media library when KB_CHAT_MEDIA=on (FR-1): the directory must be writable and
 * every migration must apply, or the API does not start, with a message that says why.
 */
export async function createMedia(
  config: AppConfig,
  secrets: { readonly tokenKey: Buffer },
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
  return {
    ...openStores(dir),
    files,
    workerToken,
    tokenKey: secrets.tokenKey,
    createPerMinute: config.MEDIA_CREATE_RATE_LIMIT,
    ai: {
      model: config.MEDIA_AI_MODEL,
      runCapUsd: config.MEDIA_AI_RUN_CAP_USD,
      monthlyCapUsd: config.MEDIA_MONTHLY_CAP_USD,
    },
  };
}

/** The stores that live in the media database. */
type MediaStores = Pick<
  MediaDeps,
  | 'store'
  | 'listening'
  | 'bookmarks'
  | 'transcripts'
  | 'transcribers'
  | 'trackProposals'
  | 'spend'
  | 'silences'
  | 'search'
>;

/** The queue, each person's listening and bookmarks share one database (ADR 0022). */
function openStores(dir: string): MediaStores {
  try {
    const db = openMediaDatabase(join(dir, 'media.db'), MEDIA_MIGRATIONS);
    return {
      store: new SqliteMediaStore(db),
      listening: new SqliteListeningStore(db),
      bookmarks: new SqliteBookmarkStore(db),
      transcripts: new SqliteTranscriptStore(db),
      transcribers: new SqliteTranscriberStore(db),
      trackProposals: new SqliteTrackProposalStore(db),
      spend: new SqliteMediaSpendLedger(db),
      silences: new SqliteSilenceStore(db),
      search: new SqliteMediaSearch(db),
    };
  } catch (err) {
    throw new Error(
      `The media library cannot start: the media database in ${dir} did not open or migrate`,
      { cause: err },
    );
  }
}
