import { posix } from 'node:path';
import type {
  OriginalFile,
  TopicFolder,
  VaultReaderPort,
} from '../../ports/vault-reader.js';
import type { RemovalRecords } from './removal-records.js';

/**
 * The vault without what was removed in the app (KBC-187): every reader of the API goes through
 * it, so a removed document is in no catalog, search, text, answer or count from the next load
 * of its collection on, whether the Mac already moved the file or not.
 */
export class RemovedVault implements VaultReaderPort {
  constructor(
    private readonly vault: VaultReaderPort,
    private readonly removals: RemovalRecords,
  ) {}

  listTopics(): Promise<readonly TopicFolder[]> {
    return this.vault.listTopics();
  }

  async listDocuments(topic: string): Promise<readonly string[]> {
    const ids = await this.vault.listDocuments(topic);
    return ids.filter((id) => !this.removals.isRemoved(topic, id));
  }

  async readDocument(topic: string, id: string): Promise<string | null> {
    // However the path is spelled, it is the same file.
    return this.removals.isRemovedIn(topic, posix.normalize(id))
      ? null
      : this.vault.readDocument(topic, id);
  }

  findOriginal(
    topic: string,
    original: { readonly sha256: string; readonly extension: string },
  ): Promise<OriginalFile | null> {
    return this.vault.findOriginal?.(topic, original) ?? Promise.resolve(null);
  }
}
