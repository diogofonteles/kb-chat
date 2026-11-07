import type { Author } from '@kb-chat/contracts';
import type { MediaRecord, MediaStorePort } from '../../ports/media-store.js';
import type { TrackItemStorePort } from '../../ports/track-item-store.js';
import type {
  TranscriptStorePort,
  TranscriptSummary,
} from '../../ports/transcript-store.js';
import type { DocumentSegment, TrackDocumentInput } from './track-document.js';

export interface DocumentSourceDeps {
  readonly store: Pick<MediaStorePort, 'getMedia'>;
  readonly items: Pick<TrackItemStorePort, 'published'>;
  readonly transcripts: Pick<TranscriptStorePort, 'transcripts' | 'segments'>;
  /** Whether a recording has, or ever had, a track (KBC-100 FR-7). */
  readonly hasTracks: (recordingId: string) => boolean;
  /** The collection's main author's slug (ADR 0030), or null. */
  readonly mainOf: (topic: string) => string | null;
  readonly authorOf: (topic: string, slug: string) => Author | null;
  /** The collection's `domain` (its topic.yaml); null without one. */
  readonly domainOf: (topic: string) => string | null;
  /** The accepted subjects of a track (KBC-069), by name. */
  readonly subjectsOf: (track: {
    mediaId: string;
    topic: string;
  }) => readonly string[];
  /**
   * Who speaks in each segment of a media's current transcript, by the names a listener
   * sees (KBC-065; names still waiting for a person are not said); null where nobody is
   * named. Without it, no paragraph names its speaker.
   */
  readonly speakersOf?: (mediaId: string) => readonly (string | null)[];
}

/** A track the app may put in the collection: published, ready, not archived (ADR 0035 §1). */
export const isPublishable = (
  media: MediaRecord | null,
): media is MediaRecord & { track: NonNullable<MediaRecord['track']> } =>
  media !== null &&
  media.track !== null &&
  media.status === 'ready' &&
  media.archivedAt === null;

/** A recording, not a track: ready and not archived. */
const isLiveRecording = (media: MediaRecord | null): media is MediaRecord =>
  media !== null &&
  media.track === null &&
  media.status === 'ready' &&
  media.archivedAt === null;

/**
 * What a media's document is made of, read from media.db at render time: its current
 * transcript (a track's slice on the track's clock), who it is by and where it sits in its
 * recording. A published track has one; so has a transcribed recording that never had a
 * track (KBC-100 FR-7: its whole text). Null for anything else, or with no transcript yet.
 */
export class TrackDocumentSource {
  constructor(private readonly deps: DocumentSourceDeps) {}

  inputOf(mediaId: string): TrackDocumentInput | null {
    const media = this.deps.store.getMedia(mediaId);
    if (isPublishable(media)) return this.trackInput(media);
    if (isLiveRecording(media) && !this.deps.hasTracks(media.id))
      return this.recordingInput(media);
    return null;
  }

  /** Whether a media may be in the AI research as a document now (ADR 0035 §5). */
  isDocumentable(media: MediaRecord | null): boolean {
    if (isPublishable(media)) return true;
    return isLiveRecording(media) && !this.deps.hasTracks(media.id);
  }

  private trackInput(
    media: MediaRecord & { track: NonNullable<MediaRecord['track']> },
  ): TrackDocumentInput | null {
    const [current] = this.deps.transcripts.transcripts(media.id);
    const parent = this.deps.store.getMedia(media.track.parentId);
    if (!current || !parent) return null;
    return {
      ...this.common(media, current),
      kind: 'track',
      recordingId: parent.id,
      recordingTitle: parent.title,
      ordinal: media.track.ordinal,
      total: this.deps.items.published(parent.id).length || null,
      startMs: media.track.startMs,
      durationMs: media.durationMs ?? media.track.endMs - media.track.startMs,
    };
  }

  private recordingInput(media: MediaRecord): TrackDocumentInput | null {
    const [current] = this.deps.transcripts.transcripts(media.id);
    if (!current) return null;
    const segments = this.deps.transcripts.segments(current.id);
    return {
      ...this.common(media, current),
      kind: 'recording',
      recordingId: media.id,
      recordingTitle: media.title,
      ordinal: null,
      total: null,
      startMs: 0,
      durationMs: media.durationMs ?? segments.at(-1)?.endMs ?? 0,
    };
  }

  /** What a track and a whole recording render alike. */
  private common(media: MediaRecord, current: TranscriptSummary) {
    const { authorship, author } = this.authorOf(media);
    return {
      topic: media.topic,
      mediaId: media.id,
      title: media.title,
      confidence: current.confidence,
      authorship,
      author,
      subjects: this.deps.subjectsOf({ mediaId: media.id, topic: media.topic }),
      domain: this.deps.domainOf(media.topic),
      transcribedAt: current.createdAt,
      segments: this.segmentsOf(media.id, current),
    };
  }

  private segmentsOf(
    mediaId: string,
    current: TranscriptSummary,
  ): readonly DocumentSegment[] {
    const segments = this.deps.transcripts.segments(current.id);
    const speakers = this.deps.speakersOf?.(mediaId) ?? [];
    return segments.map(({ startMs, endMs, text }, index) => ({
      startMs,
      endMs,
      text,
      speaker: speakers[index] ?? null,
    }));
  }

  /** The live tracks of a recording, in the order of its approval. */
  tracksOf(parentId: string): readonly string[] {
    return this.deps.items.published(parentId).map((item) => item.mediaId);
  }

  /** Who a media is by: the main author's group or the others (ADR 0015, ADR 0030). */
  private authorOf(media: MediaRecord) {
    const slug = media.author;
    const main = this.deps.mainOf(media.topic);
    return {
      authorship:
        slug !== null && slug === main
          ? ('mestre-laercio' as const)
          : ('outros-autores' as const),
      author: slug
        ? (this.deps.authorOf(media.topic, slug)?.name ?? null)
        : null,
    };
  }
}
