import type { Author } from '@kb-chat/contracts';
import type { MediaRecord, MediaStorePort } from '../../ports/media-store.js';
import type { TrackItemStorePort } from '../../ports/track-item-store.js';
import type { TranscriptStorePort } from '../../ports/transcript-store.js';
import type { TrackDocumentInput } from './track-document.js';

export interface DocumentSourceDeps {
  readonly store: Pick<MediaStorePort, 'getMedia'>;
  readonly items: Pick<TrackItemStorePort, 'published'>;
  readonly transcripts: Pick<TranscriptStorePort, 'transcripts' | 'segments'>;
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
}

/** A track the app may put in the collection: published, ready, not archived (ADR 0035 §1). */
export const isPublishable = (
  media: MediaRecord | null,
): media is MediaRecord & { track: NonNullable<MediaRecord['track']> } =>
  media !== null &&
  media.track !== null &&
  media.status === 'ready' &&
  media.archivedAt === null;

/**
 * What a track's document is made of, read from media.db at render time: its current
 * transcript (the slice on the track's clock), who it is by and where it sits in its
 * recording. Null for a track that is not publishable or has no transcript yet.
 */
export class TrackDocumentSource {
  constructor(private readonly deps: DocumentSourceDeps) {}

  inputOf(mediaId: string): TrackDocumentInput | null {
    const media = this.deps.store.getMedia(mediaId);
    if (!isPublishable(media)) return null;
    const [current] = this.deps.transcripts.transcripts(mediaId);
    const parent = this.deps.store.getMedia(media.track.parentId);
    if (!current || !parent) return null;
    const { authorship, author } = this.authorOf(media);
    return {
      topic: media.topic,
      mediaId,
      kind: 'track',
      title: media.title,
      recordingId: parent.id,
      recordingTitle: parent.title,
      ordinal: media.track.ordinal,
      total: this.deps.items.published(parent.id).length || null,
      startMs: media.track.startMs,
      durationMs: media.durationMs ?? media.track.endMs - media.track.startMs,
      confidence: current.confidence,
      authorship,
      author,
      subjects: this.deps.subjectsOf({ mediaId, topic: media.topic }),
      domain: this.deps.domainOf(media.topic),
      transcribedAt: current.createdAt,
      segments: this.deps.transcripts.segments(current.id),
    };
  }

  /** The live tracks of a recording, in the order of its approval. */
  tracksOf(parentId: string): readonly string[] {
    return this.deps.items.published(parentId).map((item) => item.mediaId);
  }

  /** Who a track is by: the main author's group or the others (ADR 0015, ADR 0030). */
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
