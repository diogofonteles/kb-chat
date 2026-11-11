import type { MediaBookmark } from '@kb-chat/contracts';

/** A bookmark with the media it belongs to, for "Meus marcadores" (KBC-042 FR-5). */
export interface BookmarkWithMedia extends MediaBookmark {
  readonly mediaTitle: string;
  readonly mediaTopic: string;
  /** The media's level and whether it is a track: who still sees it (KBC-105). */
  readonly mediaLevel: string | null;
  readonly mediaIsTrack: boolean;
  readonly mediaDurationMs: number | null;
}

/** The track a bookmark fell out of on its way to the recording (KBC-073 BR-4). */
export interface LeftTrack {
  readonly mediaId: string;
  readonly title: string;
}

/**
 * Each person's bookmarks (KBC-042). Kept in the media database (ADR 0022); a removed media
 * takes its bookmarks along (BR-3). Every read and write is scoped to one person (BR-1).
 */
export interface BookmarkStorePort {
  /** The bookmark with this id, whoever it belongs to; null when there is none. */
  bookmark(id: string): (MediaBookmark & { readonly principal: string }) | null;
  /** One person's bookmarks in one media, by position. */
  bookmarksOf(principal: string, mediaId: string): MediaBookmark[];
  countOf(principal: string, mediaId: string): number;
  /** One person's bookmarks in every media, newest first. */
  allOf(principal: string): BookmarkWithMedia[];
  /** `left`: it was made on a track's replaced cut and fell out; its owner is told (BR-4). */
  addBookmark(input: {
    readonly principal: string;
    readonly bookmark: MediaBookmark;
    readonly left?: LeftTrack;
  }): void;
  /** False when the person has no such bookmark in that media. */
  updateNote(input: {
    readonly principal: string;
    readonly mediaId: string;
    readonly id: string;
    readonly note: string | null;
    readonly now: Date;
  }): boolean;
  deleteBookmark(input: {
    readonly principal: string;
    readonly mediaId: string;
    readonly id: string;
  }): boolean;
}
