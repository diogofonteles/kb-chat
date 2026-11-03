import type { MediaTranscript } from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type {
  TranscriptStorePort,
  TranscriptSummary,
} from '../../ports/transcript-store.js';
import type { MediaActor } from './media-service.js';
import {
  SUBTITLE_RULES_VERSION,
  cuesOf,
  formatWebVtt,
} from './subtitle-cues.js';

export interface TranscriptServiceDeps {
  readonly transcripts: Pick<
    TranscriptStorePort,
    'transcripts' | 'segments' | 'words'
  >;
  /** Who sees which media: `get` throws the stream's 404 (KBC-038 FR-1). */
  readonly media: { get(actor: MediaActor, mediaId: string): unknown };
  /** WebVTT files kept in memory (the most recently used). */
  readonly cacheSize?: number;
}

/** A media's subtitles and the tag that names their version (transcript, filter, rules). */
export interface Subtitles {
  readonly etag: string;
  readonly body: string;
}

const DEFAULT_CACHE_SIZE = 32;

const noTranscript = () =>
  new AppError('MEDIA_NOT_READY', 'This media has no transcript yet');

/** Changes with a new transcript, a new post-filter or new subtitle rules. */
const etagOf = (summary: TranscriptSummary): string =>
  `"${summary.id}.f${summary.filterVersion}.s${SUBTITLE_RULES_VERSION}"`;

/**
 * The current transcript for reading and its WebVTT subtitles (KBC-038), for whoever may
 * listen to the media. Subtitles are derived from the stored words (ADR 0023 §8) and kept
 * per version: changing the rules re-derives them without transcribing again.
 */
export class TranscriptService {
  private readonly vtt = new Map<string, string>();
  private readonly cacheSize: number;

  constructor(private readonly deps: TranscriptServiceDeps) {
    this.cacheSize = deps.cacheSize ?? DEFAULT_CACHE_SIZE;
  }

  current(actor: MediaActor, mediaId: string): MediaTranscript {
    const summary = this.currentOf(actor, mediaId);
    return {
      mediaId,
      version: summary.version,
      confidence: summary.confidence,
      segments: this.deps.transcripts
        .segments(summary.id)
        .map(({ startMs, endMs, text }) => ({ startMs, endMs, text })),
    };
  }

  subtitles(actor: MediaActor, mediaId: string): Subtitles {
    const summary = this.currentOf(actor, mediaId);
    const etag = etagOf(summary);
    const cached = this.vtt.get(etag);
    if (cached !== undefined) {
      // Most recently used goes last; the first one is the oldest.
      this.vtt.delete(etag);
      this.vtt.set(etag, cached);
      return { etag, body: cached };
    }
    const body = this.derive(summary.id);
    this.remember(etag, body);
    return { etag, body };
  }

  private derive(transcriptId: string): string {
    const { transcripts } = this.deps;
    return formatWebVtt(
      cuesOf({
        segments: transcripts.segments(transcriptId),
        words: transcripts.words(transcriptId),
      }),
    );
  }

  private remember(etag: string, body: string): void {
    this.vtt.set(etag, body);
    const oldest = this.vtt.keys().next();
    if (this.vtt.size > this.cacheSize && !oldest.done)
      this.vtt.delete(oldest.value);
  }

  /** The newest version (BR-1), once the person may see the media (404 otherwise). */
  private currentOf(actor: MediaActor, mediaId: string): TranscriptSummary {
    this.deps.media.get(actor, mediaId);
    const [newest] = this.deps.transcripts.transcripts(mediaId);
    if (!newest) throw noTranscript();
    return newest;
  }
}
