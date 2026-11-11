import type {
  TrackChange,
  TrackChangeField,
  TrackCutState,
  TrackImpact,
  MovedBookmarksEntry,
} from '@kb-chat/contracts';

/** The two people of a track. */
export type TrackRole = 'asker' | 'answerer';

/** An approved track with what the edit of it reads. */
export interface RevisableTrack {
  readonly trackId: string;
  readonly mediaId: string;
  readonly parentId: string;
  readonly ordinal: number;
  readonly title: string;
  /** What was asked: while a cut runs, the file still has the old bounds. */
  readonly startMs: number;
  readonly endMs: number;
  readonly askerVoice: number | null;
  readonly answererVoice: number | null;
  readonly askerSpeakerId: string | null;
  readonly answererSpeakerId: string | null;
  readonly cut: TrackCutState;
  /** A finished cut that waits for its approval's others. */
  readonly hasCandidate: boolean;
}

/** A track out of the edit, not yet past its window. */
export interface ArchivedTrackRow {
  readonly mediaId: string;
  readonly title: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly archivedAt: string;
}

/** A replaced cut, kept for who is on it (BR-3). */
export interface OldTrackFile {
  readonly path: string;
  readonly mime: string;
  readonly startMs: number;
}

/** Who made a change, as the history keeps it. */
export interface ChangeAuthor {
  readonly principal: string;
  readonly name: string;
  readonly now: Date;
}

export interface NewChange {
  readonly field: TrackChangeField;
  readonly before: string | null;
  readonly after: string | null;
}

/**
 * What changes a track after its approval (KBC-073). `media_tracks` and the draft change
 * together, so that reopening the edit shows the truth; every write joins the caller's
 * transaction.
 */
export interface TrackRevisionStorePort {
  /** Runs `work` in one transaction; what the writes below need to be whole. */
  atomically<T>(work: () => T): T;
  track(mediaId: string): RevisableTrack | null;
  tracks(parentId: string): readonly RevisableTrack[];
  /** False when `expectedVersion` is old (BR-10). */
  bump(mediaId: string, expectedVersion: number): boolean;
  /** Every track whose speakers changed: nobody's open form is right any more. */
  touch(mediaId: string): void;
  /** A person's title: from now on it is theirs (KBC-090). */
  rename(track: RevisableTrack, title: string, now: Date): void;
  /** The AI's title with a corrected name: still the AI's. */
  renameProposed(track: RevisableTrack, title: string, now: Date): void;
  setSpeaker(
    track: RevisableTrack,
    change: { readonly role: TrackRole; readonly speakerId: string | null },
  ): void;
  /** Tracks of this voice that named `former` or nobody go back to following the voice. */
  followVoice(input: {
    readonly parentId: string;
    readonly voice: number;
    readonly former: string | null;
  }): void;
  /** New asked bounds and a cut job; a failed job leaves. */
  moveBounds(input: {
    readonly track: RevisableTrack;
    readonly startMs: number;
    readonly endMs: number;
    readonly jobId: string;
    readonly now: Date;
  }): void;
  /** The row goes aside, with its cut job; the path of a candidate it left, to remove. */
  archive(track: RevisableTrack, now: Date): string | null;
  /** Back as it was; `trackId` names it when no row was kept (it left by a new approval). */
  restore(input: {
    readonly mediaId: string;
    readonly trackId: string;
    readonly principal: string;
    readonly now: Date;
  }): void;
  /** Tracks archived since `since`, newest first. */
  archived(parentId: string, since: Date): readonly ArchivedTrackRow[];
  impact(mediaId: string): TrackImpact;
  record(
    mediaId: string,
    changes: readonly NewChange[],
    author: ChangeAuthor,
  ): void;
  history(mediaId: string): TrackChange[];
  oldFile(mediaId: string, fileVersion: number): OldTrackFile | null;
  /** Forgets the cuts replaced before `before`; their paths, to remove. */
  takeOldFiles(before: Date): readonly string[];
  /** Forgets the files of tracks archived before `before`; the records stay (BR-7). */
  takeArchivedFiles(before: Date): readonly string[];
  /** With the recording's collection: the notice is only for who still sees it. */
  movedBookmarks(
    principal: string,
  ): readonly (MovedBookmarksEntry & { readonly topic: string })[];
  /** One track's notice: the others are still unread. */
  acknowledgeMoved(principal: string, trackId: string): void;
}
