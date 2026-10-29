import type { MediaPreferences } from '@kb-chat/contracts';

/** Where one person is in one media (KBC-041 FR-2, BR-2). */
export interface ListeningProgress {
  readonly positionMs: number;
  /** ISO time the person heard it to 95% or more; null otherwise. */
  readonly completedAt: string | null;
}

/** A saved position, with when the server saved it. */
export interface SavedProgress extends ListeningProgress {
  readonly updatedAt: string;
}

/**
 * Each person's way of listening (KBC-041): their preferences and their position in each
 * media. Kept in the media database (ADR 0022); a removed media takes its positions along.
 */
export interface ListeningStorePort {
  preferencesOf(principal: string): MediaPreferences | null;
  savePreferences(input: {
    readonly principal: string;
    readonly preferences: MediaPreferences;
    readonly now: Date;
  }): void;
  /** The person's progress in each of these media; absent when never saved. */
  progressOf(
    principal: string,
    mediaIds: readonly string[],
  ): ReadonlyMap<string, SavedProgress>;
  saveProgress(input: {
    readonly principal: string;
    readonly mediaId: string;
    readonly progress: ListeningProgress;
    readonly now: Date;
  }): void;
}
