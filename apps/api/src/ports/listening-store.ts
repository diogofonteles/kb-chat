import type { ListeningPreferences } from '@kb-chat/contracts';

/** Where one person is in one media (KBC-041 FR-2, BR-2). */
export interface ListeningProgress {
  readonly positionMs: number;
  /** ISO time the person heard it to 95% or more; null otherwise. */
  readonly completedAt: string | null;
}

/** A saved position, with when the server saved it. */
export interface SavedProgress extends ListeningProgress {
  readonly updatedAt: string;
  /** When a player last saved it (KBC-051); null when only marked as heard or not. */
  readonly playedAt: string | null;
}

/** One media marked as heard or not: no player saved it (KBC-051 BR-5). */
export interface ListeningMark {
  readonly mediaId: string;
  readonly progress: ListeningProgress;
  readonly now: Date;
}

/**
 * Each person's way of listening (KBC-041): their preferences and their position in each
 * media. Kept in the media database (ADR 0022); a removed media takes its positions along.
 */
export interface ListeningStorePort {
  preferencesOf(principal: string): ListeningPreferences | null;
  savePreferences(input: {
    readonly principal: string;
    readonly preferences: ListeningPreferences;
    readonly now: Date;
  }): void;
  /** The person's progress in each of these media; absent when never saved. */
  progressOf(
    principal: string,
    mediaIds: readonly string[],
  ): ReadonlyMap<string, SavedProgress>;
  /** Every progress the person has (the library, KBC-051). */
  allProgressOf(principal: string): ReadonlyMap<string, SavedProgress>;
  saveProgress(input: {
    readonly principal: string;
    readonly mediaId: string;
    readonly progress: ListeningProgress;
    readonly now: Date;
    /** A player saved it (it counts as played, KBC-051 BR-4); marking does not. */
    readonly played: boolean;
  }): void;
  /** Marks several media at once: all of them are saved, or none (KBC-051 FR-3). */
  markMany(input: {
    readonly principal: string;
    readonly marks: readonly ListeningMark[];
  }): void;
  /** When the person last chose "Limpar recentes" (KBC-051 BR-4); null when never. */
  recentsClearedAt(principal: string): string | null;
  clearRecents(input: { readonly principal: string; readonly now: Date }): void;
}
