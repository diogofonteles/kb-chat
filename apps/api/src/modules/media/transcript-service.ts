import type {
  HiddenSpan,
  LearnedSpan,
  MediaTranscript,
  MediaTranscriptWords,
  TranscriptSpeakers,
  TranscriptWordsQuery,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { MediaRecord, MediaStorePort } from '../../ports/media-store.js';
import type {
  TranscriptStorePort,
  TranscriptSummary,
} from '../../ports/transcript-store.js';
import type { TranscriptVoices } from './diarization-service.js';
import { hiddenTagOf } from './masked-stream.js';
import type { MediaActor } from './media-service.js';
import { touchesHidden } from './track-levels.js';
import {
  SUBTITLE_RULES_VERSION,
  cuesOf,
  formatWebVtt,
} from './subtitle-cues.js';

export interface TranscriptServiceDeps {
  readonly transcripts: Pick<
    TranscriptStorePort,
    'transcripts' | 'segments' | 'words' | 'wordsOfSegments' | 'termVersion'
  >;
  /** Who sees which media: `get` throws the stream's 404 (KBC-038 FR-1). */
  readonly media: {
    get(
      actor: MediaActor,
      mediaId: string,
    ): {
      readonly archived: boolean;
      /** What this person may not hear of it (KBC-106 FR-2). */
      readonly hidden?: readonly HiddenSpan[];
    };
  };
  /** A track's bounds, to read its voices from the recording (KBC-068 FR-3). */
  readonly recording?: Pick<MediaStorePort, 'getMedia'>;
  /** The current separation on a transcript (KBC-064 FR-4); null before the first. */
  readonly voices?: (
    mediaId: string,
    transcript: TranscriptSummary,
  ) => TranscriptVoices | null;
  /** Who a track names in its voices, over the recording's names (KBC-073 FR-1). */
  readonly trackVoices?: (
    mediaId: string,
    topic: string,
  ) => readonly {
    readonly voice: number;
    readonly speakerId: string;
    readonly name: string;
  }[];
  /** The learning's replacements in force in these segments (KBC-113 FR-5). */
  readonly learnedOn?: (
    transcriptId: string,
    segments: { readonly from: number; readonly count: number },
  ) => LearnedSpan[];
  /** WebVTT files kept in memory (the most recently used). */
  readonly cacheSize?: number;
}

/** What the person may read besides the text. */
export interface TranscriptAudience {
  readonly withVoices: boolean;
  readonly withNames: boolean;
  /** Masters also see which term list it was made with (KBC-040 FR-4). */
  readonly withTermList?: boolean;
}

const NOBODY: TranscriptAudience = { withVoices: false, withNames: false };

/** Names waiting for a person's confirmation are not said to listeners yet (BR-5). */
const namesForListeners = ({ labels, namesPending }: TranscriptSpeakers) =>
  namesPending
    ? labels.map(({ voice }) => ({
        voice,
        kind: 'unnamed' as const,
        speakerId: null,
        name: null,
        main: false,
      }))
    : labels;

/** A media's subtitles and the tag that names their version (transcript, filter, rules). */
export interface Subtitles {
  readonly etag: string;
  readonly body: string;
}

const DEFAULT_CACHE_SIZE = 32;

/**
 * KBC-106 BR-2: a segment touching a hidden part stays in its place (positions of words and
 * corrections do not move) with no text and no voice.
 */
function restrictedIn(
  transcript: MediaTranscript,
  hidden: readonly HiddenSpan[],
): MediaTranscript {
  if (hidden.length === 0) return transcript;
  return {
    ...transcript,
    segments: transcript.segments.map((segment) =>
      touchesHidden(hidden, segment)
        ? {
            startMs: segment.startMs,
            endMs: segment.endMs,
            text: '',
            ...(segment.voice !== undefined && { voice: null }),
            restricted: true as const,
          }
        : segment,
    ),
  };
}

/** A learned span names a word left out. */
const overlapsPositions = (
  span: { readonly position: number; readonly count: number },
  dropped: ReadonlySet<number>,
): boolean => {
  for (let at = span.position; at < span.position + span.count; at++)
    if (dropped.has(at)) return true;
  return false;
};

const noTranscript = () =>
  new AppError('MEDIA_NOT_READY', 'This media has no transcript yet');

/**
 * Changes with a new transcript, a word correction (its revision, KBC-093 FR-7), a new
 * post-filter or new subtitle rules.
 */
const etagOf = (summary: TranscriptSummary): string =>
  `"${summary.id}.r${summary.revision}.f${summary.filterVersion}.s${SUBTITLE_RULES_VERSION}"`;

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

  /**
   * The transcript; with `withVoices` (`media-edit`, KBC-064 FR-4) its separation and names,
   * with `withNames` (`media-speakers`, KBC-065 FR-4) only who speaks in each segment.
   */
  current(
    actor: MediaActor,
    mediaId: string,
    options: TranscriptAudience = NOBODY,
  ): MediaTranscript {
    const { summary, hidden } = this.readable(actor, mediaId);
    const segments = this.deps.transcripts
      .segments(summary.id)
      .map(({ startMs, endMs, text }) => ({ startMs, endMs, text }));
    const transcript = {
      mediaId,
      version: summary.version,
      revision: summary.revision,
      confidence: summary.confidence,
      segments,
      ...(options.withTermList ? this.termListOf(summary) : {}),
    };
    return restrictedIn(
      this.withSpeakers(transcript, summary, options),
      hidden,
    );
  }

  private termListOf(summary: TranscriptSummary) {
    const list = this.deps.transcripts.termVersion(summary.termsVersion);
    return list
      ? { termList: { version: list.version, createdAt: list.createdAt } }
      : {};
  }

  /** A page of the current transcript's words: apart, so `current` never scans them all. */
  words(
    actor: MediaActor,
    mediaId: string,
    range: TranscriptWordsQuery,
  ): MediaTranscriptWords {
    const { summary, hidden } = this.readable(actor, mediaId);
    const { kept, dropped } = this.wordsHeard(summary.id, range, hidden);
    return {
      mediaId,
      version: summary.version,
      revision: summary.revision,
      words: kept,
      learned: (this.deps.learnedOn?.(summary.id, range) ?? []).filter(
        (span) => !overlapsPositions(span, dropped),
      ),
    };
  }

  /** A page of words, those touching a hidden part left out (KBC-106 BR-2). */
  private wordsHeard(
    transcriptId: string,
    range: TranscriptWordsQuery,
    hidden: readonly HiddenSpan[],
  ) {
    const closed = this.closedSegments(transcriptId, hidden);
    const words = this.deps.transcripts
      .wordsOfSegments(transcriptId, range)
      .map(({ position, segment, startMs, endMs, text }) => ({
        position,
        segment,
        startMs,
        endMs,
        text,
      }));
    const kept = words.filter(
      (word) => !closed.has(word.segment) && !touchesHidden(hidden, word),
    );
    const dropped = new Set(
      words.filter((word) => !kept.includes(word)).map((one) => one.position),
    );
    return { kept, dropped };
  }

  /** The transcript with what `audience` may read of the current separation, if any. */
  private withSpeakers(
    transcript: MediaTranscript,
    summary: TranscriptSummary,
    audience: TranscriptAudience,
  ): MediaTranscript {
    const voices =
      audience.withVoices || audience.withNames
        ? this.voicesOf(transcript, summary)
        : null;
    if (!voices) return transcript;
    const { speakers } = voices;
    const voiced = {
      ...transcript,
      segments: transcript.segments.map((segment, index) => ({
        ...segment,
        voice: voices.segmentVoices[index] ?? null,
      })),
    };
    return audience.withVoices
      ? { ...voiced, speakers, voiceNames: speakers.labels }
      : { ...voiced, voiceNames: namesForListeners(speakers) };
  }

  /** A track has no separation: each segment says the voice at that time of its recording. */
  private voicesOf(
    transcript: MediaTranscript,
    summary: TranscriptSummary,
  ): TranscriptVoices | null {
    const { voices, recording } = this.deps;
    const record = recording?.getMedia(transcript.mediaId);
    const track = record?.track;
    if (!track) return voices?.(transcript.mediaId, summary) ?? null;
    const [current] = this.deps.transcripts.transcripts(track.parentId);
    const whole = current ? voices?.(track.parentId, current) : null;
    if (!current || !whole) return null;
    const source = this.deps.transcripts.segments(current.id);
    const voiceAt = (ms: number): number | null => {
      const index = source.findIndex(
        (one) => ms >= one.startMs && ms < one.endMs,
      );
      return whole.segmentVoices[index] ?? null;
    };
    return {
      ...whole,
      speakers: this.namedHere(whole.speakers, record),
      segmentVoices: transcript.segments.map((segment) =>
        voiceAt(track.startMs + (segment.startMs + segment.endMs) / 2),
      ),
    };
  }

  /** What the track says of its own voices wins over the recording's names (KBC-073 FR-1). */
  private namedHere(
    speakers: TranscriptSpeakers,
    record: Pick<MediaRecord, 'id' | 'topic'>,
  ): TranscriptSpeakers {
    const own = this.deps.trackVoices?.(record.id, record.topic) ?? [];
    const labels = speakers.labels.map((label) => {
      const named = own.find((one) => one.voice === label.voice);
      return named
        ? {
            ...label,
            kind: 'person' as const,
            speakerId: named.speakerId,
            name: named.name,
          }
        : label;
    });
    return { ...speakers, labels };
  }

  subtitles(actor: MediaActor, mediaId: string): Subtitles {
    const { summary, hidden } = this.readable(actor, mediaId);
    const etag =
      hidden.length > 0
        ? etagOf(summary).replace(/"$/, `.h${hiddenTagOf(hidden)}"`)
        : etagOf(summary);
    const cached = this.vtt.get(etag);
    if (cached !== undefined) {
      // Most recently used goes last; the first one is the oldest.
      this.vtt.delete(etag);
      this.vtt.set(etag, cached);
      return { etag, body: cached };
    }
    const body = this.derive(summary.id, hidden);
    this.remember(etag, body);
    return { etag, body };
  }

  /** The cues with what this person may not hear left out (KBC-106 BR-2). */
  private derive(transcriptId: string, hidden: readonly HiddenSpan[]): string {
    const { transcripts } = this.deps;
    const closed = this.closedSegments(transcriptId, hidden);
    const segments = transcripts
      .segments(transcriptId)
      .map((segment, index) =>
        closed.has(index) ? { ...segment, text: '' } : segment,
      );
    const words = transcripts
      .words(transcriptId)
      .filter(
        (word) => !closed.has(word.segment) && !touchesHidden(hidden, word),
      );
    return formatWebVtt(
      cuesOf({ segments, words }).filter((cue) => cue.text.trim() !== ''),
    );
  }

  /** The positions of the segments that touch a hidden part. */
  private closedSegments(
    transcriptId: string,
    hidden: readonly HiddenSpan[],
  ): ReadonlySet<number> {
    if (hidden.length === 0) return new Set();
    const closed = new Set<number>();
    this.deps.transcripts.segments(transcriptId).forEach((segment, index) => {
      if (touchesHidden(hidden, segment)) closed.add(index);
    });
    return closed;
  }

  private remember(etag: string, body: string): void {
    this.vtt.set(etag, body);
    const oldest = this.vtt.keys().next();
    if (this.vtt.size > this.cacheSize && !oldest.done)
      this.vtt.delete(oldest.value);
  }

  /** The newest version (BR-1), once the person may see the media (404 otherwise). */
  /**
   * A deleted track's text goes with its sound (KBC-073 BR-5, KBC-099 BUG-1): an old answer
   * that cites it may not read its passage any more.
   */
  private readable(
    actor: MediaActor,
    mediaId: string,
  ): { summary: TranscriptSummary; hidden: readonly HiddenSpan[] } {
    const item = this.deps.media.get(actor, mediaId);
    if (item.archived) throw new AppError('MEDIA_NOT_FOUND', 'Unknown media');
    const [newest] = this.deps.transcripts.transcripts(mediaId);
    if (!newest) throw noTranscript();
    return { summary: newest, hidden: item.hidden ?? [] };
  }
}
