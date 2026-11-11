export interface TopicFolder {
  readonly slug: string;
  readonly title: string;
  /** The collection this one sits in (one level only, ADR 0028). */
  readonly parent?: string;
  readonly description?: string;
  /** topic.yaml's `domain` (e.g. `esoterismo`): what kb files the collection under. */
  readonly domain?: string;
  /**
   * Created on the screen with no folder in the vault yet (ADR 0028): nothing of the app
   * is published there (KBC-100 AC-12).
   */
  readonly screenOnly?: true;
}

/** Read-only access to a kb vault; every path is confined to its topic folder. */
export interface VaultReaderPort {
  listTopics(): Promise<readonly TopicFolder[]>;
  /** Topic-relative paths of the markdown documents kb-chat serves. */
  listDocuments(topic: string): Promise<readonly string[]>;
  /** File text, or null when the document does not exist inside the topic. */
  readDocument(topic: string, id: string): Promise<string | null>;
}
