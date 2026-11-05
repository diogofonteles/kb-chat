import type { TranscriptConfidence } from '@kb-chat/contracts';

/** What a document's `kb_chat_*` keys say about its track (the catalog's view). */
export interface ShelfQuery {
  readonly mediaId: string;
  readonly fingerprint: string;
}

/** A track as media.db has it now, for the research tools (ADR 0035 §5). */
export interface ShelfTrack {
  readonly mediaId: string;
  readonly title: string;
  readonly confidence: TranscriptConfidence;
}

/** One segment of a track's current transcript, on the track's clock. */
export interface ShelfSegment {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * The tracks one person may research in one turn (KBC-099 BR-4): a document of a track is
 * seen only while media.db confirms it (it exists, is ready, not archived, still in this
 * collection) and the person has the collection, `research`, `media` and `media-research`.
 * Without a shelf, no track is seen at all.
 */
export interface TrackShelf {
  trackOf(topic: string, query: ShelfQuery): ShelfTrack | null;
  /** The track's current segments (exact times for citations, ADR 0035 §6). */
  segmentsOf(mediaId: string): readonly ShelfSegment[];
}
