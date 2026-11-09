import type { MediaRecord, MediaStorePort } from '../../ports/media-store.js';
import type {
  ShelfQuery,
  ShelfSegment,
  ShelfTrack,
  TrackShelf,
} from '../../ports/track-shelf.js';
import type { TranscriptStorePort } from '../../ports/transcript-store.js';
import { isMediaDocument } from './document-source.js';

export interface MediaTrackShelfDeps {
  readonly store: Pick<MediaStorePort, 'getMedia'>;
  readonly transcripts: Pick<TranscriptStorePort, 'transcripts' | 'segments'>;
  /**
   * Whether a recording has, or ever had, a track: a recording that never had one is a
   * document of its own (KBC-100 FR-7). Without it, only tracks are seen.
   */
  readonly hasTracks?: (recordingId: string) => boolean;
  /** The fingerprint media.db wants now (KBC-100); without it, nothing is "atualizando". */
  readonly desiredOf?: (mediaId: string) => string | null;
}

/**
 * The tracks of one research turn, as media.db has them (ADR 0035 §5): the vault may still
 * hold the document of a track archived, deleted or moved a minute ago; this says no at once.
 * Built for a person who may research tracks; each answer is kept for the turn.
 */
export class MediaTrackShelf implements TrackShelf {
  private readonly tracks = new Map<string, ShelfTrack | null>();
  private readonly segments = new Map<string, readonly ShelfSegment[]>();

  constructor(private readonly deps: MediaTrackShelfDeps) {}

  trackOf(topic: string, query: ShelfQuery): ShelfTrack | null {
    const key = `${topic}\n${query.mediaId}\n${query.fingerprint ?? ''}`;
    if (!this.tracks.has(key)) this.tracks.set(key, this.read(topic, query));
    return this.tracks.get(key) ?? null;
  }

  private read(
    topic: string,
    { mediaId, fingerprint }: ShelfQuery,
  ): ShelfTrack | null {
    const media = this.deps.store.getMedia(mediaId);
    if (!this.isDocument(media) || media.topic !== topic) return null;
    const [current] = this.deps.transcripts.transcripts(mediaId);
    if (!current) return null;
    const desired = this.deps.desiredOf?.(mediaId) ?? null;
    return {
      mediaId,
      title: media.title,
      confidence: current.confidence,
      stale:
        fingerprint !== undefined &&
        desired !== null &&
        desired !== fingerprint,
    };
  }

  /** A published track, or a live recording that never had one (ADR 0035 §1). */
  private isDocument(media: MediaRecord | null): media is MediaRecord {
    const { hasTracks } = this.deps;
    // Without `hasTracks`, only tracks are seen.
    return isMediaDocument(media, hasTracks ?? (() => true));
  }

  segmentsOf(mediaId: string): readonly ShelfSegment[] {
    const known = this.segments.get(mediaId);
    if (known) return known;
    const [current] = this.deps.transcripts.transcripts(mediaId);
    const segments = current
      ? this.deps.transcripts
          .segments(current.id)
          .map(({ startMs, endMs }) => ({ startMs, endMs }))
      : [];
    this.segments.set(mediaId, segments);
    return segments;
  }
}
