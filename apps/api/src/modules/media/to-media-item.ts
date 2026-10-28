import type { MediaFailure, MediaItem } from '@kb-chat/contracts';
import type { MediaRecord } from '../../ports/media-store.js';

/** Failures a new conversion may fix; a bad file or a lost upload never will. */
const RETRYABLE: ReadonlySet<MediaFailure> = new Set([
  'conversion-failed',
  'too-many-attempts',
]);

/** The contract view of a stored item; only masters may retry (KBC-034 FR-7). */
export function toMediaItem(record: MediaRecord, isMaster: boolean): MediaItem {
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
  };
}
