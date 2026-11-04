import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { AppConfig } from './config.js';
import { FsMediaFiles } from './adapters/media/fs-media-files.js';
import { FsVoicePrintVault } from './adapters/media/fs-voice-print-vault.js';
import { FsVoiceRevocationList } from './adapters/media/fs-voice-revocation-list.js';
import { SecretBox } from './adapters/secret-box.js';
import { openMediaDatabase } from './adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from './adapters/sqlite/media-migrations.js';
import { SqliteDiarizationStore } from './adapters/sqlite/sqlite-diarization-store.js';
import {
  SqliteSpeakerStore,
  SqliteVoiceLabelStore,
} from './adapters/sqlite/sqlite-speaker-store.js';
import { SqliteBookmarkStore } from './adapters/sqlite/sqlite-bookmark-store.js';
import { SqliteListeningStore } from './adapters/sqlite/sqlite-listening-store.js';
import { SqliteMediaEditStore } from './adapters/sqlite/sqlite-media-edit-store.js';
import { SqliteMediaSpendLedger } from './adapters/sqlite/sqlite-media-spend-ledger.js';
import { SqliteMediaSearch } from './adapters/sqlite/sqlite-media-search.js';
import { SqliteMediaStore } from './adapters/sqlite/sqlite-media-store.js';
import { SqliteTrackProposalStore } from './adapters/sqlite/sqlite-track-proposal-store.js';
import { SqliteSilenceStore } from './adapters/sqlite/sqlite-silence-store.js';
import { SqliteTranscriberStore } from './adapters/sqlite/sqlite-transcriber-store.js';
import { SqliteTranscriptStore } from './adapters/sqlite/sqlite-transcript-store.js';
import { SqliteWaveformStore } from './adapters/sqlite/sqlite-waveform-store.js';
import { SqliteVoiceProfileStore } from './adapters/sqlite/sqlite-voice-profile-store.js';
import type { DiarizationStorePort } from './ports/diarization-store.js';
import type {
  SpeakerStorePort,
  VoiceLabelStorePort,
} from './ports/speaker-store.js';
import type { BookmarkStorePort } from './ports/bookmark-store.js';
import type { ListeningStorePort } from './ports/listening-store.js';
import type { MediaFilesPort } from './ports/media-files.js';
import type { MediaEditStorePort } from './ports/media-edit-store.js';
import type { MediaSpendLedgerPort } from './ports/media-spend-ledger.js';
import type { MediaSearchPort } from './ports/media-search.js';
import type { MediaStorePort } from './ports/media-store.js';
import type { TrackProposalStorePort } from './ports/track-proposal-store.js';
import type { SilenceStorePort } from './ports/silence-store.js';
import type { TranscriberStorePort } from './ports/transcriber-store.js';
import type { TranscriptStorePort } from './ports/transcript-store.js';
import type { WaveformStorePort } from './ports/waveform-store.js';
import type { SecretSealerPort } from './ports/secret-sealer.js';
import type { VoicePrintVaultPort } from './ports/voice-print-vault.js';
import type { VoiceRevocationListPort } from './ports/voice-revocation-list.js';
import type { VoiceProfileStorePort } from './ports/voice-profile-store.js';

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
  /** The draft's edit and the approved tracks (KBC-066). */
  readonly edits: MediaEditStorePort;
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
  /** Waveform peaks (KBC-066). */
  readonly waveforms: WaveformStorePort;
  /** The current transcripts' search index (KBC-039, ADR 0024). */
  readonly search: MediaSearchPort;
  /** Voice separations (KBC-064). */
  readonly diarizations: DiarizationStorePort;
  /** The speakers of each collection and who each voice is (KBC-065). */
  readonly speakers: SpeakerStorePort;
  readonly voiceLabels: VoiceLabelStorePort;
  /** Consents, voice profiles and suggestions (KBC-071). */
  readonly voiceProfiles: VoiceProfileStorePort;
  /** The prints themselves, outside the database and the backup (ADR 0032). */
  readonly voicePrintVault: VoicePrintVaultPort;
  readonly voiceRevocations: VoiceRevocationListPort;
  /** Seals the proof of each consent. */
  readonly consentSealer: SecretSealerPort;
  readonly files: MediaFilesPort;
  readonly workerToken: string;
  /** Keys the transcriber token hashes (KB_CHAT_SECRETS_KEY, ADR 0017). */
  readonly tokenKey: Buffer;
  /** Items created per minute per client (MEDIA_CREATE_RATE_LIMIT). */
  readonly createPerMinute: number;
}

/** Keys derived for the media library, one per purpose (ADR 0017). */
export interface MediaSecrets {
  readonly tokenKey: Buffer;
  /** Seals the voice prints (ADR 0032). */
  readonly voicePrintKey: Buffer;
  /** Seals the proof of each consent. */
  readonly consentKey: Buffer;
}

/**
 * Opens the media library when KB_CHAT_MEDIA=on (FR-1): the directory must be writable and
 * every migration must apply, or the API does not start, with a message that says why.
 */
export async function createMedia(
  config: AppConfig,
  secrets: MediaSecrets,
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
    ...voiceSafes(dir, secrets),
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

/** What holds biometric data and consents' proofs, sealed (ADR 0032). */
const voiceSafes = (dir: string, secrets: MediaSecrets) => ({
  voicePrintVault: new FsVoicePrintVault(
    join(dir, 'voice-prints'),
    new SecretBox(secrets.voicePrintKey),
  ),
  voiceRevocations: new FsVoiceRevocationList(
    join(dir, 'voice-revocations.list'),
  ),
  consentSealer: new SecretBox(secrets.consentKey),
});

/** The stores that live in the media database (ADR 0022). */
type MediaStores = Pick<
  MediaDeps,
  | 'store'
  | 'listening'
  | 'bookmarks'
  | 'transcripts'
  | 'transcribers'
  | 'trackProposals'
  | 'edits'
  | 'spend'
  | 'silences'
  | 'waveforms'
  | 'search'
  | 'diarizations'
  | 'speakers'
  | 'voiceLabels'
  | 'voiceProfiles'
>;

/** The queue, each person's listening and bookmarks share one database (ADR 0022). */
function openStores(dir: string): MediaStores {
  try {
    return storesOf(openMediaDatabase(join(dir, 'media.db'), MEDIA_MIGRATIONS));
  } catch (err) {
    throw new Error(
      `The media library cannot start: the media database in ${dir} did not open or migrate`,
      { cause: err },
    );
  }
}

function storesOf(db: DatabaseSync): MediaStores {
  return {
    store: new SqliteMediaStore(db),
    listening: new SqliteListeningStore(db),
    bookmarks: new SqliteBookmarkStore(db),
    transcripts: new SqliteTranscriptStore(db),
    transcribers: new SqliteTranscriberStore(db),
    trackProposals: new SqliteTrackProposalStore(db),
    edits: new SqliteMediaEditStore(db),
    spend: new SqliteMediaSpendLedger(db),
    silences: new SqliteSilenceStore(db),
    waveforms: new SqliteWaveformStore(db),
    search: new SqliteMediaSearch(db),
    diarizations: new SqliteDiarizationStore(db),
    speakers: new SqliteSpeakerStore(db),
    voiceLabels: new SqliteVoiceLabelStore(db),
    voiceProfiles: new SqliteVoiceProfileStore(db),
  };
}
