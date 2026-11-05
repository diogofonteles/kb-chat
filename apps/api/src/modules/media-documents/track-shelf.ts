import type { MediaStorePort } from '../../ports/media-store.js';
import type {
  ShelfQuery,
  ShelfSegment,
  ShelfTrack,
  TrackShelf,
} from '../../ports/track-shelf.js';
import type { TranscriptStorePort } from '../../ports/transcript-store.js';
import { isPublishable } from './document-source.js';

export interface MediaTrackShelfDeps {
  readonly store: Pick<MediaStorePort, 'getMedia'>;
  readonly transcripts: Pick<TranscriptStorePort, 'transcripts' | 'segments'>;
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
    const key = `${topic}\n${query.mediaId}`;
    if (!this.tracks.has(key)) this.tracks.set(key, this.read(topic, query));
    return this.tracks.get(key) ?? null;
  }

  private read(topic: string, { mediaId }: ShelfQuery): ShelfTrack | null {
    const media = this.deps.store.getMedia(mediaId);
    if (!isPublishable(media) || media.topic !== topic) return null;
    const [current] = this.deps.transcripts.transcripts(mediaId);
    if (!current) return null;
    return { mediaId, title: media.title, confidence: current.confidence };
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
