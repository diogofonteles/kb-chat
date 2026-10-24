import type { PeopleStorePort } from '../ports/people-store.js';
import { readJsonFile, writeJsonFile } from './atomic-json.js';

/** `<state>/people.json` (ADR 0008): 0600, replaced atomically. */
export class JsonPeopleStore implements PeopleStorePort {
  constructor(private readonly file: string) {}

  read(): Promise<unknown> {
    return readJsonFile(this.file);
  }

  write(value: object): Promise<void> {
    return writeJsonFile(this.file, value);
  }
}
