import type {
  MediaFailure,
  MediaItem,
  MediaTranscription,
  TranscriptionStatus,
} from '@kb-chat/contracts';
import type { SavedProgress } from '../../ports/listening-store.js';
import type {
  JobStatus,
  MediaRecord,
  TranscriptionRecord,
} from '../../ports/media-store.js';
import type { Presence } from './transcriber-service.js';

/** Failures a new conversion may fix; a bad file or a lost upload never will. */
const RETRYABLE: ReadonlySet<MediaFailure> = new Set([
  'conversion-failed',
  'too-many-attempts',
]);

const isRetryable = (record: MediaRecord): boolean =>
  record.status === 'failed' &&
  record.failure !== null &&
  RETRYABLE.has(record.failure);

/** What the person sees next to an item: their position, the transcribers' presence. */
export interface ItemView {
  readonly progress?: SavedProgress;
  readonly presence?: Presence;
}

const NO_TRANSCRIBER: Presence = { transcriber: 'none', offSince: null };

/** The newest job decides while it runs; otherwise a transcript means done. */
const STATUS_BY_JOB: Record<
  JobStatus,
  (hasTranscript: boolean) => TranscriptionStatus
> = {
  queued: () => 'waiting',
  leased: () => 'transcribing',
  done: (has) => (has ? 'done' : 'none'),
  failed: (has) => (has ? 'done' : 'failed'),
  dead: (has) => (has ? 'done' : 'failed'),
};

function toTranscription(
  record: TranscriptionRecord,
  presence: Presence,
): MediaTranscription {
  const hasTranscript = record.version !== null;
  const status = record.jobStatus
    ? STATUS_BY_JOB[record.jobStatus](hasTranscript)
    : hasTranscript
      ? 'done'
      : 'none';
  return {
    status,
    confidence: record.confidence,
    version: record.version,
    transcriber: presence.transcriber,
    transcriberOffSince: presence.offSince,
  };
}

/**
 * The contract view of a stored item for one person: only masters may retry (KBC-034
 * FR-7), the position is theirs (KBC-041 FR-2), and its transcription (KBC-036).
 */
export function toMediaItem(
  record: MediaRecord,
  isMaster: boolean,
  view: ItemView = {},
): MediaItem {
  const { progress } = view;
  return {
    id: record.id,
    topic: record.topic,
    title: record.title,
    authorship: record.authorship,
    status: record.status,
    progress: record.status === 'processing' ? record.progress : null,
    failure: record.failure,
    durationMs: record.durationMs,
    bytes: record.bytes,
    createdAt: record.createdAt,
    canRetry: isMaster && isRetryable(record),
    positionMs: progress?.positionMs ?? 0,
    completedAt: progress?.completedAt ?? null,
    positionUpdatedAt: progress?.updatedAt ?? null,
    transcription: toTranscription(
      record.transcription,
      view.presence ?? NO_TRANSCRIBER,
    ),
  };
}
