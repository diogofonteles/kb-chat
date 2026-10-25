/**
 * One JSON document under the state dir (access-requests.json, codes.json; ADR 0011),
 * owner-only (0600) and replaced atomically; in memory in tests.
 */
export interface DocumentStorePort {
  /** The parsed document, or null before the first write. */
  read(): Promise<unknown>;
  write(value: object): Promise<void>;
}
