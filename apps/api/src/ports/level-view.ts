import type { ContentLevel } from '@kb-chat/contracts';

/**
 * A document as a view judges it: its id in its own collection and its track, if any (the
 * catalog's `CatalogEntry` is one).
 */
export interface ViewedDocument {
  readonly id: string;
  /** The track (or recording) of media.db a document was rendered from (ADR 0035). */
  readonly media: { readonly mediaId: string } | null;
}

/** One collection's documents (the catalog's `TopicCatalog` is one). */
export interface ViewedCollection {
  readonly topic: { readonly slug: string };
  readonly entries: ReadonlyMap<string, ViewedDocument>;
}

/** A document of a collection seen from its parent: where it really is (ADR 0028). */
export interface ScopedDocument extends ViewedDocument {
  readonly home?: { readonly topic: string; readonly id: string };
}

/** A collection and its sub-collections as one set (the catalog's `ScopeView` is one). */
export interface ViewedScope<E extends ScopedDocument> {
  readonly topic: string;
  readonly entries: ReadonlyMap<string, E>;
}

/**
 * What one person may see of one collection and its sub-collections (ADR 0036 §6, §7): the
 * only way services reach content. Every set-based surface filters with it before it counts
 * or groups. A port, so the research ports can carry the turn's view (KBC-104).
 */
export interface LevelView {
  /** Every item is visible: a master, or a collection without levels. */
  readonly seesAll: boolean;
  /** The collection's top level has a scale. */
  readonly scaled: boolean;
  /** May see the levels of items (badges, "Mudar nível"): masters (BR-9). */
  readonly manages: boolean;
  /** Whether the viewer may see this document of `collection` (by its id there). */
  allows(collection: string, entry: ViewedDocument): boolean;
  /**
   * The documents of a scope the viewer may see (ADR 0036 §7), each judged in the
   * collection it is in: the set the research tools and the sweep start from (KBC-104).
   */
  entries<E extends ScopedDocument>(scope: ViewedScope<E>): readonly E[];
  /** Visible texts / texts of the collection, at least 0.05 (the candidate budget). */
  visibleShare(catalog: ViewedCollection): number;
  /** A document's level for whoever manages levels in a scaled collection; else undefined. */
  levelOf(collection: string, id: string): ContentLevel | undefined;
  /** The level ids the viewer sees, for SQL filters (KBC-105); null: every item. */
  allowedLevelIds(): readonly string[] | null;
  /**
   * A track's number and its recording's total among the tracks the viewer hears (KBC-111,
   * owner decision): null when they hear every track (the stored numbers stand).
   */
  trackPlace(mediaId: string): TrackPlace | null;
}

/** "faixa n de N", counted over what one viewer hears. */
export interface TrackPlace {
  /** Null when the track is not among the live tracks the viewer hears. */
  readonly ordinal: number | null;
  readonly total: number;
}

/** A live track of a recording with its level, as media.db holds it. */
export interface PlacedTrack {
  readonly mediaId: string;
  readonly level: string | null;
  readonly startMs: number;
}
