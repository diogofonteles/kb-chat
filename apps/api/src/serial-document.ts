import type { DocumentStorePort } from './ports/document-store.js';

/** What a change returns: the next document (the same object when nothing changed). */
export interface DocumentChange<T, R> {
  readonly doc: T;
  readonly result: R;
}

export interface SerialDocumentOptions<T> {
  readonly store: DocumentStorePort;
  /** Validates what was read (throws on a corrupt file). */
  readonly parse: (raw: unknown) => T;
  readonly empty: () => T;
}

/**
 * A JSON document whose changes apply one after the other (codes, access requests; ADR
 * 0011), so two requests never overwrite each other's write.
 */
export class SerialDocument<T extends object> {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SerialDocumentOptions<T>) {}

  read(): Promise<T> {
    return this.queue.then(() => this.load());
  }

  change<R>(
    apply: (doc: T) => DocumentChange<T, R> | Promise<DocumentChange<T, R>>,
  ): Promise<R> {
    const run = this.queue.then(async () => {
      const current = await this.load();
      const { doc, result } = await apply(current);
      if (doc !== current) await this.options.store.write(doc);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<T> {
    const raw = await this.options.store.read();
    return raw === null ? this.options.empty() : this.options.parse(raw);
  }
}
