/**
 * Voice prints at rest (KBC-071, ADR 0032): sealed, one per profile, outside the media
 * database and so outside its backup. Only the voice profile services touch this port.
 */
export interface VoicePrintVaultPort {
  put(profileId: string, embedding: readonly number[]): Promise<void>;
  /** The print; null when there is none, or it no longer opens (another master key). */
  read(profileId: string): Promise<number[] | null>;
  /** Whether it is there and opens: one that cannot be compared is not ready. */
  opens(profileId: string): Promise<boolean>;
  /** Removes it, and any unfinished write of it, for good; nothing there is no error. */
  remove(profileId: string): Promise<void>;
  /** The profile id of every print on disk. */
  ids(): Promise<string[]>;
  /** Removes what a crash left half written; how many there were. */
  removeUnfinished(): Promise<number>;
}
