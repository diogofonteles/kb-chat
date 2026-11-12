import type {
  Author,
  ContentLevel,
  HiddenSpan,
  MediaAuthor,
  MediaFailure,
  MediaItem,
  MediaTranscription,
  TrackParent,
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
  /** Its author as the collection's list names it now (KBC-049); null is "Outros autores". */
  readonly author?: MediaAuthor;
  /** The person may change its details (KBC-050 BR-1). */
  readonly canEdit?: boolean;
  /** A track's recording (KBC-068 FR-4). */
  readonly parent?: TrackParent | null;
  /** Groq is on and has a key: a master may send a waiting transcription to it (KBC-037). */
  readonly groqReady?: boolean;
  /** Its level, for masters and its editors in a collection with levels (KBC-105). */
  readonly level?: ContentLevel;
  /** The parts this person may not hear (KBC-106 FR-2); empty or absent: none. */
  readonly hidden?: readonly HiddenSpan[];
  /** Its tracks' own levels, for whoever sees its level (KBC-106 BR-1). */
  readonly ownTrackLevels?: readonly string[];
}

/** The stored author as the list now names it (still shown if no longer listed, KBC-049). */
export function mediaAuthorOf(
  record: MediaRecord,
  authorOf: (topic: string, slug: string) => Author | null,
): MediaAuthor {
  if (record.author === null) return null;
  return (
    authorOf(record.topic, record.author) ?? {
      slug: record.author,
      name: record.author,
      main: false,
    }
  );
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
  isMaster: boolean,
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
    lastAttemptFailed:
      isMaster &&
      hasTranscript &&
      (record.jobStatus === 'failed' || record.jobStatus === 'dead'),
    provider: record.provider,
    route: record.route,
    hold: record.jobStatus === 'queued' ? record.hold : null,
  };
}

/** Its transcription waits for a paired transcriber: Groq may take it (KBC-037). */
const waitsForTranscriber = (record: MediaRecord): boolean =>
  record.status === 'ready' &&
  !record.track &&
  record.transcription.jobStatus === 'queued' &&
  record.transcription.route === 'transcriber';

/**
 * Ready, with no transcription waiting or running (KBC-040 FR-3). A track follows its
 * recording's transcript (KBC-068), and the API refuses it.
 */
const canAskAgain = (record: MediaRecord): boolean =>
  record.status === 'ready' &&
  !record.track &&
  record.transcription.jobStatus !== 'queued' &&
  record.transcription.jobStatus !== 'leased';

/** What a master may ask of its transcription: again (KBC-040), or of Groq (KBC-037). */
const transcriptionActions = (
  record: MediaRecord,
  isMaster: boolean,
  view: ItemView,
) => ({
  canTranscribeAgain: isMaster && canAskAgain(record),
  canUseGroq:
    isMaster && (view.groqReady ?? false) && waitsForTranscriber(record),
});

/** Where it sits: its recording, whether it left the edit, and its level for who may see it. */
const placeOf = (
  record: MediaRecord,
  { parent, level, hidden, ownTrackLevels }: ItemView,
) => ({
  ...(hidden && hidden.length > 0 ? { hidden: [...hidden] } : {}),
  ...(ownTrackLevels && ownTrackLevels.length > 0
    ? { ownTrackLevels: [...ownTrackLevels] }
    : {}),
  parent: parent ?? null,
  archived: record.archivedAt !== null,
  // KBC-105, ADR 0036 §9: absent for whoever does not manage or edit it.
  ...(level === undefined ? {} : { level }),
});

const progressOf = (progress: ItemView['progress']) => ({
  positionMs: progress?.positionMs ?? 0,
  completedAt: progress?.completedAt ?? null,
  positionUpdatedAt: progress?.updatedAt ?? null,
});

/**
 * The contract view of a stored item for one person: only masters may retry (KBC-034
 * FR-7), the position is theirs (KBC-041 FR-2), and its transcription (KBC-036).
 */
export function toMediaItem(
  record: MediaRecord,
  isMaster: boolean,
  view: ItemView = {},
): MediaItem {
  const { author = null } = view;
  return {
    id: record.id,
    topic: record.topic,
    title: record.title,
    author,
    status: record.status,
    progress: record.status === 'processing' ? record.progress : null,
    failure: record.failure,
    durationMs: record.durationMs,
    bytes: record.bytes,
    createdAt: record.createdAt,
    canRetry: isMaster && isRetryable(record),
    canEdit: view.canEdit ?? false,
    ...transcriptionActions(record, isMaster, view),
    ...progressOf(view.progress),
    transcription: toTranscription(
      record.transcription,
      view.presence ?? NO_TRANSCRIBER,
      isMaster,
    ),
    ...placeOf(record, view),
  };
}
