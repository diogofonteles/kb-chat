import type { DocumentStorePort } from '../ports/document-store.js';
import { readJsonFile, writeJsonFile } from './atomic-json.js';

/** A JSON document under the state dir: 0600, replaced atomically (ADR 0011). */
export class JsonDocumentStore implements DocumentStorePort {
  constructor(private readonly file: string) {}

  read(): Promise<unknown> {
    return readJsonFile(this.file);
  }

  write(value: object): Promise<void> {
    return writeJsonFile(this.file, value);
  }
}
