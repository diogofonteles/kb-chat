/** The revocations on record: opaque profile ids, nothing about a person or a voice. */
export interface VoiceRevocations {
  readonly ids: readonly string[];
  /**
   * False when the list was lost (a lost disk, say): earlier revocations are unknown, so no
   * print may be made until the owner has checked them and marked the list as started.
   */
  readonly complete: boolean;
  /**
   * When the app started the list, with the first consent; null when the owner marked it as
   * checked, or nobody did. A consent older than this is older than the list (ADR 0032 §4).
   */
  readonly startedAt: string | null;
}

/**
 * Who revoked (KBC-071 BR-2, ADR 0032), kept where no restore of the media database reaches:
 * a backup older than a revocation must not bring that consent back.
 */
export interface VoiceRevocationListPort {
  /** Reaches the disk before it returns: revoking relies on it. */
  add(profileId: string): Promise<void>;
  read(): Promise<VoiceRevocations>;
  /** Starts the list, dated: only with the first consent of a media library. */
  start(at: Date): Promise<void>;
}
