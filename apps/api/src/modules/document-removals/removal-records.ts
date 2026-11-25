import type {
  RemovalRecord,
  RemovalStorePort,
} from '../../ports/document-removals.js';

/**
 * The removals in memory, one writer (the API), saved whole after each change in order: what
 * is removed is hidden at once, and on disk when the change resolves (as UploadRecords).
 */
export class RemovalRecords {
  private readonly records = new Map<string, RemovalRecord>();
  private saving: Promise<void> = Promise.resolve();

  private constructor(private readonly store: RemovalStorePort) {}

  static async open(store: RemovalStorePort): Promise<RemovalRecords> {
    const opened = new RemovalRecords(store);
    for (const record of await store.load())
      opened.records.set(record.id, record);
    return opened;
  }

  get(id: string): RemovalRecord | undefined {
    return this.records.get(id);
  }

  all(): readonly RemovalRecord[] {
    return [...this.records.values()];
  }

  of(topic: string, documentId: string): RemovalRecord | undefined {
    return this.all().find(
      (one) => one.topic === topic && one.document.id === documentId,
    );
  }

  /** The app hides it: not listed, not read, not found. */
  isRemoved(topic: string, documentId: string): boolean {
    return this.of(topic, documentId)?.wish === 'removed';
  }

  /** The same, by the id a collection's scope gives it (a sub-collection's has its folder). */
  isRemovedIn(topic: string, id: string): boolean {
    if (this.isRemoved(topic, id)) return true;
    return this.all().some(
      (one) =>
        one.wish === 'removed' &&
        one.topic.startsWith(`${topic}/`) &&
        `${one.topic.slice(topic.length + 1)}/${one.document.id}` === id,
    );
  }

  put(record: RemovalRecord): Promise<void> {
    this.records.set(record.id, record);
    return this.save();
  }

  /** Changes it as it is now; undefined when it is gone. */
  async update(
    id: string,
    change: (current: RemovalRecord) => RemovalRecord,
  ): Promise<RemovalRecord | undefined> {
    const current = this.records.get(id);
    if (!current) return undefined;
    const changed = change(current);
    await this.put(changed);
    return changed;
  }

  remove(id: string): Promise<void> {
    this.records.delete(id);
    return this.save();
  }

  private save(): Promise<void> {
    const run = this.saving.then(() => this.store.save(this.all()));
    this.saving = run.catch(() => undefined);
    return run;
  }
}
