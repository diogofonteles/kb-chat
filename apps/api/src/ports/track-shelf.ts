import type { TranscriptConfidence } from '@kb-chat/contracts';

/**
 * What a document's `kb_chat_*` keys say about its track (the catalog's view). Only the id
 * decides: whether the vault's text is behind media.db ("atualizando") is KBC-100's.
 */
export interface ShelfQuery {
  readonly mediaId: string;
  /** The catalog's `kb_chat_fingerprint`: behind media.db's wish, the track is "atualizando". */
  readonly fingerprint?: string;
}

/** A track as media.db has it now, for the research tools (ADR 0035 §5). */
export interface ShelfTrack {
  readonly mediaId: string;
  readonly title: string;
  readonly confidence: TranscriptConfidence;
  /** The vault's document is behind what media.db wants now (KBC-100 "atualizando"). */
  readonly stale?: boolean;
}

/** One segment of a track's current transcript, on the track's clock. */
export interface ShelfSegment {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * The tracks one person may see as documents (ADR 0035 §5): a document of a track is seen
 * only while media.db confirms it (it exists, is ready, not archived, still in this
 * collection). The research builds one for who has the collection, `research`, `media`,
 * `media-tracks` and `media-research` (KBC-099 BR-4); the documents search for who has the
 * collection, `media` and `media-tracks` (KBC-101 BR-7). Without a shelf, no track is seen.
 */
export interface TrackShelf {
  trackOf(topic: string, query: ShelfQuery): ShelfTrack | null;
  /** The track's current segments (exact times for citations, ADR 0035 §6). */
  segmentsOf(mediaId: string): readonly ShelfSegment[];
}
