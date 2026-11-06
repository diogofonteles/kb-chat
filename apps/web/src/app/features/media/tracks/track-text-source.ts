import { httpResource } from '@angular/common/http';
import {
  Injectable,
  computed,
  inject,
  signal,
  type Signal,
} from '@angular/core';
import {
  mediaTranscriptSchema,
  type MediaPreparation,
  type MediaItem,
  type MediaTranscript,
} from '@kb-chat/contracts';
import { MediaApi, mediaTranscriptUrl } from '@core/media/media-api.js';
import { TranscriptWords } from '../transcript/transcript-words.js';

/**
 * Where the media's transcript is, as a page knows it. `key` changes whenever a newer
 * transcript may be there, so it is read again (FR-6).
 */
export interface TextTarget {
  readonly mediaId: string;
  readonly status: 'waiting' | 'failed' | 'none' | 'done';
  readonly key: string;
}

/** What a track's text block shows (T20, "Texto da faixa"). */
export type TrackTextState =
  'loading' | 'waiting' | 'failed' | 'none' | 'error' | 'ready';

/** Step 3: the media item's transcription, read with the page. */
export function itemTarget(item: MediaItem): TextTarget {
  const { status, version } = item.transcription;
  if (version !== null)
    return { mediaId: item.id, status: 'done', key: `${version}` };
  return { mediaId: item.id, status: notDone(status), key: '' };
}

const MOVING = new Set(['waiting', 'queued', 'running', 'blocked']);

/**
 * Step 2: the item says which transcript there was when the page opened; the transcription
 * stage, read every 3 s, says when a new one ended, which reads the transcript again.
 */
export function preparationTarget(
  item: MediaItem,
  preparation: MediaPreparation | null,
): TextTarget {
  const stage = preparation?.stages.find((one) => one.stage === 'transcribe');
  const { version } = item.transcription;
  if (!stage) return itemTarget(item);
  const key = `${version ?? 0}.${stage.state}`;
  if (stage.state === 'done' || version !== null)
    return { mediaId: item.id, status: 'done', key };
  return {
    mediaId: item.id,
    status: MOVING.has(stage.state) ? 'waiting' : 'failed',
    key,
  };
}

function notDone(status: MediaItem['transcription']['status']) {
  if (status === 'waiting' || status === 'transcribing') return 'waiting';
  return status === 'failed' ? 'failed' : 'none';
}

const NO_TRANSCRIPT: MediaTranscript = {
  mediaId: '00000000-0000-4000-8000-000000000000',
  version: 1,
  confidence: 'normal',
  segments: [],
};

/**
 * The transcript behind the tracks' text, once per page (FR-3): read only when the first
 * text opens, and its words a page of 100 segments at a time (KBC-045's `TranscriptWords`).
 * Provided by the page that shows the texts.
 */
@Injectable()
export class TrackTextSource {
  private readonly api = inject(MediaApi);
  private readonly target = signal<Signal<TextTarget | null>>(signal(null));
  private readonly asked = signal(false);
  private readonly read = httpResource(
    () => {
      const target = this.target()();
      if (!this.asked() || target?.status !== 'done') return undefined;
      return {
        url: mediaTranscriptUrl(target.mediaId),
        params: { v: target.key },
      };
    },
    { parse: (body) => mediaTranscriptSchema.parse(body) },
  );

  /** The transcript read; null before, while reading or after a failure. */
  readonly transcript = computed(() =>
    this.read.hasValue() ? this.read.value() : null,
  );
  /** Its words: a new version drops the old ones (FR-6). */
  readonly words = new TranscriptWords(
    computed(() => this.transcript() ?? NO_TRANSCRIPT),
    (id, range) => this.api.transcriptWords(id, range),
  );
  readonly state = computed<TrackTextState>(() => {
    const target = this.target()();
    if (target === null) return 'loading';
    if (target.status !== 'done') return target.status;
    if (this.read.error()) return 'error';
    return this.transcript() ? 'ready' : 'loading';
  });

  /** The page says where its transcript is (in its constructor). */
  follow(target: Signal<TextTarget | null>): void {
    this.target.set(target);
  }

  /** A text opened: from now on the transcript is read. */
  open(): void {
    this.asked.set(true);
  }

  /** "Tentar de novo", or the page knows the transcript changed (names of voices). */
  reload(): void {
    this.read.reload();
  }
}
