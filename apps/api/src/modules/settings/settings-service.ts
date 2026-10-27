import type {
  InitialPreferences,
  KeyProvider,
  MaskedKey,
  SettingsUpdate,
  SettingsView,
} from '@kb-chat/contracts';
import type { SettingsStorePort } from '../../ports/settings-store.js';
import {
  DEFAULT_SETTINGS,
  applySettingsUpdate,
  publicLastTest,
  storedSettingsSchema,
  type StoredLastTest,
  type StoredSettings,
} from './stored-settings.js';

export interface SettingsServiceDeps {
  readonly store: SettingsStorePort;
  /** KB_CHAT_DAILY_CAP_USD: the cap while Settings do not set one (BR-4). */
  readonly defaultDailyCapUsd: number;
  readonly warn?: (message: string) => void;
}

/** "••••abcd" is drawn by the web; the API only ever returns the last 4 characters (BR-1). */
export const maskKey = (key: string): MaskedKey => ({
  set: true,
  last4: key.slice(-4),
});

function maskKeys(
  keys: StoredSettings['ai']['keys'],
): SettingsView['ai']['keys'] {
  return Object.fromEntries(
    Object.entries(keys).map(([provider, key]) => [provider, maskKey(key)]),
  );
}

/**
 * Preferences and AI provider of each principal (KBC-007; one owner until ADR 0008).
 * Loaded once per principal and kept in memory, so a change applies to the next request
 * without a restart (FR-5).
 */
export class SettingsService {
  private readonly cache = new Map<string, StoredSettings | null>();
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SettingsServiceDeps) {}

  /** Reads the principal's settings into memory (once). */
  async load(principal: string): Promise<void> {
    if (this.cache.has(principal)) return;
    const raw = await this.deps.store.read(principal);
    this.cache.set(principal, raw === null ? null : this.parse(raw));
  }

  /** The loaded settings, or null before the first save (the wizard shows, BR-5). */
  snapshot(principal: string): StoredSettings | null {
    return this.cache.get(principal) ?? null;
  }

  key(principal: string, provider: KeyProvider): string | undefined {
    return this.snapshot(principal)?.ai.keys[provider];
  }

  dailyCapUsd(principal: string): number {
    return (
      this.snapshot(principal)?.ai.dailyCapUsd ?? this.deps.defaultDailyCapUsd
    );
  }

  /** The principal saved their Settings at least once. */
  async exists(principal: string): Promise<boolean> {
    await this.load(principal);
    return this.snapshot(principal) !== null;
  }

  /**
   * GET /settings. Before the first save, the preferences a master set in the invitation
   * fill the defaults (KBC-028 FR-5); a saved file always wins (BR-6).
   */
  async view(
    principal: string,
    initial?: InitialPreferences,
  ): Promise<SettingsView> {
    await this.load(principal);
    const saved = this.snapshot(principal);
    const settings = saved ?? DEFAULT_SETTINGS;
    return {
      exists: saved !== null,
      preferences: saved
        ? settings.preferences
        : { ...settings.preferences, ...initial },
      ai: {
        provider: settings.ai.provider,
        models: settings.ai.models,
        keys: maskKeys(settings.ai.keys),
        dailyCapUsd: this.dailyCapUsd(principal),
        openrouter: settings.ai.openrouter,
        gemini: settings.ai.gemini,
        lastTest: publicLastTest(settings.ai.lastTest),
      },
    };
  }

  /** Saves a partial update; concurrent updates apply one after the other. */
  async update(
    principal: string,
    patch: SettingsUpdate,
    initial?: InitialPreferences,
  ): Promise<SettingsView> {
    const run = this.writing.then(() =>
      this.persist(principal, patch, initial),
    );
    this.writing = run.catch(() => undefined);
    await run;
    return this.view(principal);
  }

  /** Keeps the outcome of "Testar conexão" (KBC-023 BR-6); never the key. */
  async recordTest(principal: string, test: StoredLastTest): Promise<void> {
    const run = this.writing.then(async () => {
      await this.load(principal);
      const current = this.snapshot(principal) ?? DEFAULT_SETTINGS;
      const next = { ...current, ai: { ...current.ai, lastTest: test } };
      await this.deps.store.write(principal, next);
      this.cache.set(principal, next);
    });
    this.writing = run.catch(() => undefined);
    await run;
  }

  /** The key from "Conectar OpenRouter" for oneself (KBC-023): chosen, on free models. */
  connectOpenRouter(principal: string, key: string): Promise<SettingsView> {
    return this.update(principal, {
      ai: {
        provider: 'openrouter',
        keys: { openrouter: key },
        openrouter: { mode: 'free' },
      },
    });
  }

  private parse(raw: unknown): StoredSettings {
    const parsed = storedSettingsSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    // The file exists, so the wizard stays away; its content is never logged (keys).
    this.deps.warn?.('settings file is invalid; using the defaults');
    return DEFAULT_SETTINGS;
  }

  private async persist(
    principal: string,
    patch: SettingsUpdate,
    initial?: InitialPreferences,
  ): Promise<void> {
    await this.load(principal);
    // The first save keeps the invitation's preferences: they become the person's (KBC-028).
    const current = this.snapshot(principal) ?? {
      ...DEFAULT_SETTINGS,
      preferences: { ...DEFAULT_SETTINGS.preferences, ...initial },
    };
    const next = applySettingsUpdate(current, patch);
    await this.deps.store.write(principal, next);
    this.cache.set(principal, next);
  }
}
