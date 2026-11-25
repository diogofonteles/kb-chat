import type {
  DocumentUploadRecord,
  DocumentUploadStorePort,
} from '../../ports/document-uploads.js';

/**
 * The uploads in memory, one writer (the API), saved whole after each change in order: a
 * change is in the map at once and on disk when its `put` resolves (ADR 0040).
 */
export class UploadRecords {
  private readonly records = new Map<string, DocumentUploadRecord>();
  private saving: Promise<void> = Promise.resolve();

  private constructor(private readonly store: DocumentUploadStorePort) {}

  static async open(store: DocumentUploadStorePort): Promise<UploadRecords> {
    const opened = new UploadRecords(store);
    for (const record of await store.load())
      opened.records.set(record.id, record);
    return opened;
  }

  get(id: string): DocumentUploadRecord | undefined {
    return this.records.get(id);
  }

  all(): readonly DocumentUploadRecord[] {
    return [...this.records.values()];
  }

  /** Puts the record and saves; every save writes the latest map, one after the other. */
  put(...records: readonly DocumentUploadRecord[]): Promise<void> {
    for (const record of records) this.records.set(record.id, record);
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

  remove(...ids: readonly string[]): Promise<void> {
    for (const id of ids) this.records.delete(id);
    return this.save();
  }

  private save(): Promise<void> {
    const next = this.saving
      .catch(() => undefined)
      .then(() => this.store.save(this.all()));
    this.saving = next;
    return next;
  }
}
