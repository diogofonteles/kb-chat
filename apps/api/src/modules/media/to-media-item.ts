import type { MediaFailure, MediaItem } from '@kb-chat/contracts';
import type { ListeningProgress } from '../../ports/listening-store.js';
import type { MediaRecord } from '../../ports/media-store.js';

/** Failures a new conversion may fix; a bad file or a lost upload never will. */
const RETRYABLE: ReadonlySet<MediaFailure> = new Set([
  'conversion-failed',
  'too-many-attempts',
]);

const NOT_HEARD: ListeningProgress = { positionMs: 0, completedAt: null };

/**
 * The contract view of a stored item for one person: only masters may retry (KBC-034
 * FR-7), and the position is theirs (KBC-041 FR-2).
 */
export function toMediaItem(
  record: MediaRecord,
  isMaster: boolean,
  progress: ListeningProgress = NOT_HEARD,
): MediaItem {
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
    canRetry:
      isMaster &&
      record.status === 'failed' &&
      record.failure !== null &&
      RETRYABLE.has(record.failure),
    positionMs: progress.positionMs,
    completedAt: progress.completedAt,
  };
}
