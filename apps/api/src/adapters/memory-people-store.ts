import type { PeopleStorePort } from '../ports/people-store.js';

/** People in memory (tests), copied in and out like the file would be. */
export class MemoryPeopleStore implements PeopleStorePort {
  private value: unknown = null;

  async read(): Promise<unknown> {
    return this.value === null ? null : structuredClone(this.value);
  }

  async write(value: object): Promise<void> {
    this.value = structuredClone(value);
  }
}
