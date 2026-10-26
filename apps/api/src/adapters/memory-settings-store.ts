import type { SettingsStorePort } from '../ports/settings-store.js';

/** Settings kept in memory per principal (tests, or a server without a state folder). */
export class MemorySettingsStore implements SettingsStorePort {
  private readonly values = new Map<string, unknown>();

  async read(principal: string): Promise<unknown> {
    const value = this.values.get(principal);
    return value === undefined ? null : structuredClone(value);
  }

  async write(principal: string, value: object): Promise<void> {
    this.values.set(principal, structuredClone(value));
  }
}
