/**
 * Settings of each principal (ADR 0007): one owner in release 1 (ADR 0005), one per signed-in
 * user once ADR 0008 adds Google login. Holds API keys, so stored owner-only (0600).
 */
export interface SettingsStorePort {
  /** The principal's parsed settings, or null before their first save. */
  read(principal: string): Promise<unknown>;
  /** Replaces the principal's settings atomically. */
  write(principal: string, value: object): Promise<void>;
}
