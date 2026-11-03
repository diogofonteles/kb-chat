export interface TopicFolder {
  readonly slug: string;
  readonly title: string;
  /** The collection this one sits in (one level only, ADR 0028). */
  readonly parent?: string;
  readonly description?: string;
}

/** Read-only access to a kb vault; every path is confined to its topic folder. */
export interface VaultReaderPort {
  listTopics(): Promise<readonly TopicFolder[]>;
  /** Topic-relative paths of the markdown documents kb-chat serves. */
  listDocuments(topic: string): Promise<readonly string[]>;
  /** File text, or null when the document does not exist inside the topic. */
  readDocument(topic: string, id: string): Promise<string | null>;
}
