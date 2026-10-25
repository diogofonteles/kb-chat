import type { DocumentStorePort } from '../ports/document-store.js';

/** A document in memory (tests), copied in and out like the file would be. */
export class MemoryDocumentStore implements DocumentStorePort {
  private value: unknown = null;

  async read(): Promise<unknown> {
    return this.value === null ? null : structuredClone(this.value);
  }

  async write(value: object): Promise<void> {
    this.value = structuredClone(value);
  }
}
