import type { SecretSealerPort } from '../ports/secret-sealer.js';
import type { SettingsStorePort } from '../ports/settings-store.js';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The `ai.keys` map of a settings document, when it has one. */
function keysOf(value: unknown): Json | null {
  if (!isObject(value) || !isObject(value['ai'])) return null;
  const keys = value['ai']['keys'];
  return isObject(keys) ? keys : null;
}

function withKeys(value: Json, keys: Json): Json {
  const ai = isObject(value['ai']) ? value['ai'] : {};
  return { ...value, ai: { ...ai, keys } };
}

export interface SealedSettingsStoreOptions {
  readonly store: SettingsStorePort;
  readonly sealer: SecretSealerPort;
  /** A key that cannot be opened (another master key) is dropped with this warning. */
  readonly warn?: (message: string) => void;
}

/**
 * Settings with every provider key sealed on disk (ADR 0016). A file written before this
 * change has plain keys: they are read once and the file is rewritten sealed at once.
 */
export class SealedSettingsStore implements SettingsStorePort {
  constructor(private readonly options: SealedSettingsStoreOptions) {}

  async read(principal: string): Promise<unknown> {
    const raw = await this.options.store.read(principal);
    const keys = keysOf(raw);
    if (!keys || !isObject(raw)) return raw;
    const { opened, plain } = this.openAll(keys);
    const value = withKeys(raw, opened);
    if (plain) await this.write(principal, value);
    return value;
  }

  write(principal: string, value: object): Promise<void> {
    const keys = keysOf(value);
    if (!keys || !isObject(value))
      return this.options.store.write(principal, value);
    const sealed = Object.fromEntries(
      Object.entries(keys).map(([provider, key]) => [
        provider,
        typeof key === 'string' ? this.options.sealer.seal(key) : key,
      ]),
    );
    return this.options.store.write(principal, withKeys(value, sealed));
  }

  private openAll(keys: Json): { opened: Json; plain: boolean } {
    const { sealer, warn } = this.options;
    let plain = false;
    const opened: Json = {};
    for (const [provider, key] of Object.entries(keys)) {
      if (typeof key !== 'string') continue;
      if (!sealer.isSealed(key)) {
        plain = true;
        opened[provider] = key;
        continue;
      }
      try {
        opened[provider] = sealer.open(key);
      } catch {
        // Never the value: only that one key of this person could not be opened.
        warn?.(
          `a saved ${provider} key could not be decrypted; it was dropped`,
        );
      }
    }
    return { opened, plain };
  }
}
