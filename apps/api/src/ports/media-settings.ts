/** A setting of the media library as stored, with who wrote it last. */
export interface StoredMediaSetting {
  readonly value: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

/**
 * Settings of the media library in `media.db` (KBC-037): Groq's mode and sealed key, the
 * monthly cap the owner set. Values are opaque text; the service owns their format.
 */
export interface MediaSettingsPort {
  get(key: string): StoredMediaSetting | null;
  set(input: {
    readonly key: string;
    readonly value: string;
    readonly by: string;
    readonly now: Date;
  }): void;
}
