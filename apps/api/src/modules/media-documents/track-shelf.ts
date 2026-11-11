import type { MediaRecord, MediaStorePort } from '../../ports/media-store.js';
import type {
  ShelfQuery,
  ShelfRow,
  ShelfSegment,
  ShelfTrack,
  TrackShelf,
} from '../../ports/track-shelf.js';
import type { TranscriptStorePort } from '../../ports/transcript-store.js';
import { isMediaDocument } from './document-source.js';

/**
 * Lookups in one collection after which the shelf reads the whole collection at once: a
 * search that matched thousands of track documents asks one query, not thousands (NFR-3).
 */
export const SHELF_BULK_AFTER = 32;

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
  /** Every media of a collection at once (see SHELF_BULK_AFTER); without it, one by one. */
  readonly rowsOf?: (topic: string) => ReadonlyMap<string, ShelfRow>;
}

/**
 * The tracks of one research turn, as media.db has them (ADR 0035 §5): the vault may still
 * hold the document of a track archived, deleted or moved a minute ago; this says no at once.
 * Built for a person who may research tracks; each answer is kept for the turn.
 */
export class MediaTrackShelf implements TrackShelf {
  private readonly tracks = new Map<string, ShelfTrack | null>();
  private readonly segments = new Map<string, readonly ShelfSegment[]>();
  private readonly asked = new Map<string, number>();
  private readonly rows = new Map<string, ReadonlyMap<string, ShelfRow>>();

  constructor(private readonly deps: MediaTrackShelfDeps) {}

  trackOf(topic: string, query: ShelfQuery): ShelfTrack | null {
    const key = `${topic}\n${query.mediaId}\n${query.fingerprint ?? ''}`;
    if (!this.tracks.has(key)) this.tracks.set(key, this.read(topic, query));
    return this.tracks.get(key) ?? null;
  }

  private read(topic: string, query: ShelfQuery): ShelfTrack | null {
    const rows = this.rowsIn(topic);
    const found = rows
      ? this.fromRow(rows, query)
      : this.fromStore(topic, query);
    if (!found) return null;
    const desired = this.desiredOf(rows, query.mediaId);
    const { fingerprint } = query;
    return {
      ...found,
      stale:
        fingerprint !== undefined &&
        desired !== null &&
        desired !== fingerprint,
    };
  }

  /** What media.db wants the document to be: from the rows once read (NFR-3). */
  private desiredOf(
    rows: ReadonlyMap<string, ShelfRow> | undefined,
    mediaId: string,
  ): string | null {
    const { desiredOf } = this.deps;
    if (!desiredOf) return null;
    return rows ? (rows.get(mediaId)?.desired ?? null) : desiredOf(mediaId);
  }

  /** The collection's rows, read once it has been asked about often enough. */
  private rowsIn(topic: string): ReadonlyMap<string, ShelfRow> | undefined {
    const { rowsOf } = this.deps;
    if (!rowsOf) return undefined;
    const known = this.rows.get(topic);
    if (known) return known;
    const asked = (this.asked.get(topic) ?? 0) + 1;
    this.asked.set(topic, asked);
    if (asked <= SHELF_BULK_AFTER) return undefined;
    const rows = rowsOf(topic);
    this.rows.set(topic, rows);
    return rows;
  }

  private fromRow(
    rows: ReadonlyMap<string, ShelfRow>,
    { mediaId }: ShelfQuery,
  ): Omit<ShelfTrack, 'stale'> | null {
    const row = rows.get(mediaId);
    if (!row?.live || row.confidence === null) return null;
    // A live recording counts only while it never had a track (KBC-100 FR-7).
    if (!row.isTrack && (!this.deps.hasTracks || row.hasTracks)) return null;
    return { mediaId, title: row.title, confidence: row.confidence };
  }

  private fromStore(
    topic: string,
    { mediaId }: ShelfQuery,
  ): Omit<ShelfTrack, 'stale'> | null {
    const media = this.deps.store.getMedia(mediaId);
    if (!this.isDocument(media) || media.topic !== topic) return null;
    const [current] = this.deps.transcripts.transcripts(mediaId);
    if (!current) return null;
    return { mediaId, title: media.title, confidence: current.confidence };
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
