import { sameLinkKey } from '@kb-chat/contracts';
import type {
  DocumentUploadRecord,
  DocumentUploadStorePort,
} from '../../ports/document-uploads.js';

/** What an upload is made of: the original's hash, or the link's key. */
export interface UploadKey {
  readonly sha256: string | null;
  readonly url: string | null;
}

/**
 * The uploads in memory, one writer (the API), saved whole after each change in order: a
 * change is in the map at once and on disk when its `put` resolves (ADR 0040).
 */
export class UploadRecords {
  private readonly records = new Map<string, DocumentUploadRecord>();
  /** The ids of what is made of the same thing: thousands are asked about at once. */
  private readonly byKey = new Map<string, Set<string>>();
  private saving: Promise<void> = Promise.resolve();

  private constructor(private readonly store: DocumentUploadStorePort) {}

  static async open(store: DocumentUploadStorePort): Promise<UploadRecords> {
    const opened = new UploadRecords(store);
    for (const record of await store.load()) opened.set(record);
    return opened;
  }

  get(id: string): DocumentUploadRecord | undefined {
    return this.records.get(id);
  }

  all(): readonly DocumentUploadRecord[] {
    return [...this.records.values()];
  }

  /** The uploads of the same original, or of the same link. */
  sameAs(key: UploadKey): readonly DocumentUploadRecord[] {
    const ids = indexesOf(key).flatMap((one) => [
      ...(this.byKey.get(one) ?? []),
    ]);
    return ids.flatMap((id) => this.records.get(id) ?? []);
  }

  /** Puts the record and saves; every save writes the latest map, one after the other. */
  put(...records: readonly DocumentUploadRecord[]): Promise<void> {
    for (const record of records) this.set(record);
    return this.save();
  }

  /**
   * Changes the record as it is now, not as the caller read it before a wait: two changes at
   * once never undo each other. Answers it changed, or undefined when it is gone.
   */
  async update(
    id: string,
    change: (current: DocumentUploadRecord) => DocumentUploadRecord,
  ): Promise<DocumentUploadRecord | undefined> {
    const current = this.records.get(id);
    if (!current) return undefined;
    const changed = change(current);
    await this.put(changed);
    return changed;
  }

  /** One record by others, in one save. */
  replace(id: string, records: readonly DocumentUploadRecord[]): Promise<void> {
    this.drop(id);
    return this.put(...records);
  }

  remove(...ids: readonly string[]): Promise<void> {
    for (const id of ids) this.drop(id);
    return this.save();
  }

  private set(record: DocumentUploadRecord): void {
    // Where it was in the map, it stays: the order is the one they came in.
    this.unindex(this.records.get(record.id));
    this.records.set(record.id, record);
    for (const key of indexesOf(keyOfRecord(record))) {
      const ids = this.byKey.get(key) ?? new Set<string>();
      ids.add(record.id);
      this.byKey.set(key, ids);
    }
  }

  private drop(id: string): void {
    this.unindex(this.records.get(id));
    this.records.delete(id);
  }

  private unindex(record: DocumentUploadRecord | undefined): void {
    if (!record) return;
    for (const key of indexesOf(keyOfRecord(record))) {
      const ids = this.byKey.get(key);
      ids?.delete(record.id);
      if (ids?.size === 0) this.byKey.delete(key);
    }
  }

  private save(): Promise<void> {
    const next = this.saving
      .catch(() => undefined)
      .then(() => this.store.save(this.all()));
    this.saving = next;
    return next;
  }
}

const keyOfRecord = (record: DocumentUploadRecord): UploadKey => ({
  sha256: record.sha256,
  url: record.url === null ? null : sameLinkKey(record.url),
});

const indexesOf = ({ sha256, url }: UploadKey): string[] => [
  ...(sha256 === null ? [] : [`sha256 ${sha256}`]),
  ...(url === null ? [] : [`url ${url}`]),
];
