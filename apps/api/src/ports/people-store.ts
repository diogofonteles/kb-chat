/**
 * Who may sign in and what they may use (KBC-010, ADR 0008): one document,
 * `<state>/people.json`, owner-only (0600) and replaced atomically.
 */
export interface PeopleStorePort {
  /** The parsed document, or null before the first write. */
  read(): Promise<unknown>;
  write(value: object): Promise<void>;
}
