/** The revocations on record: opaque profile ids, nothing about a person or a voice. */
export interface VoiceRevocations {
  readonly ids: readonly string[];
  /**
   * False when the list was lost (a lost disk, say): earlier revocations are unknown, so no
   * print may be made until the owner has checked them and marked the list as started.
   */
  readonly complete: boolean;
}

/**
 * Who revoked (KBC-071 BR-2, ADR 0032), kept where no restore of the media database reaches:
 * a backup older than a revocation must not bring that consent back.
 */
export interface VoiceRevocationListPort {
  /** Reaches the disk before it returns: revoking relies on it. */
  add(profileId: string): Promise<void>;
  read(): Promise<VoiceRevocations>;
  /** Starts an empty list; only for a media library that never had a consent. */
  start(): Promise<void>;
}
