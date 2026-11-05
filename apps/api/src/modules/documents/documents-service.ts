import type {
  KbDocument,
  RelationPage,
  SeeAlso,
  SeeAlsoGroupName,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { VaultReaderPort } from '../../ports/vault-reader.js';
import {
  conceptOfArticle,
  isTrackEntry,
  splitFrontmatter,
  type CatalogEntry,
  type CatalogRegistry,
  type TopicCatalog,
} from '../catalog/index.js';

const SAFE_ID = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\0]+\.md$/;
/** References shown per "Veja também" group before "ver todos" (KBC-003 BR-3). */
export const SEE_ALSO_PREVIEW = 5;

export const isSafeDocumentId = (id: string): boolean => SAFE_ID.test(id);

export interface DocumentsServiceDeps {
  readonly catalog: CatalogRegistry;
  readonly vault: VaultReaderPort;
  /** Obsidian vault name: the vault folder's name. */
  readonly vaultName: string;
}

export interface RelationPageQuery {
  readonly group: SeeAlsoGroupName;
  readonly offset: number;
  readonly limit: number;
}

/** "Veja também" lists texts only until KBC-101 shows tracks there (ADR 0035 §8). */
function textsOf<T extends { id: string }>(
  catalog: TopicCatalog,
  refs: readonly T[],
): T[] {
  return refs.filter((ref) => {
    const entry = catalog.entries.get(ref.id);
    return !entry || !isTrackEntry(entry);
  });
}

export class DocumentsService {
  constructor(private readonly deps: DocumentsServiceDeps) {}

  async getDocument(topic: string, id: string): Promise<KbDocument> {
    const { catalog, entry } = this.requireEntry(topic, id);
    const text = await this.deps.vault.readDocument(topic, id);
    if (text === null)
      throw new AppError('DOCUMENT_NOT_FOUND', 'Document not found');
    return {
      id: entry.id,
      title: entry.title,
      summary: entry.summary,
      criterion: entry.criterion,
      concept: conceptOfArticle(entry.id),
      origin: entry.origin,
      genre: entry.genre,
      depth: entry.depth,
      relevance: entry.relevance,
      concepts: [...entry.concepts],
      authorship: entry.authorship,
      author: entry.author,
      obsidianUrl: this.obsidianUrl(topic, id),
      seeAlso: this.seeAlso(catalog, entry),
      body: splitFrontmatter(text).body.trim(),
    };
  }

  relationPage(
    topic: string,
    id: string,
    query: RelationPageQuery,
  ): RelationPage {
    const { catalog, entry } = this.requireEntry(topic, id);
    const all = textsOf(
      catalog,
      catalog.relations.groupsOf(entry)[query.group],
    );
    const end = Math.min(query.offset + query.limit, all.length);
    return {
      items: all.slice(query.offset, end),
      total: all.length,
      nextOffset: end < all.length ? end : null,
    };
  }

  private requireEntry(
    topic: string,
    id: string,
  ): { catalog: TopicCatalog; entry: CatalogEntry } {
    if (!isSafeDocumentId(id))
      throw new AppError('VALIDATION_FAILED', 'Invalid document id');
    const catalog = this.deps.catalog.get(topic);
    if (!catalog)
      throw new AppError('TOPIC_NOT_FOUND', `Unknown topic ${topic}`);
    const entry = catalog.entries.get(id);
    // A track's Markdown is for kb and the agent, never shown to people (ADR 0035 §7).
    if (!entry || isTrackEntry(entry))
      throw new AppError('DOCUMENT_NOT_FOUND', 'Document not found');
    return { catalog, entry };
  }

  private seeAlso(catalog: TopicCatalog, entry: CatalogEntry): SeeAlso {
    const groups = catalog.relations.groupsOf(entry);
    const preview = (group: SeeAlsoGroupName) => {
      const texts = textsOf(catalog, groups[group]);
      return { items: texts.slice(0, SEE_ALSO_PREVIEW), total: texts.length };
    };
    return {
      exampleOf: preview('exampleOf'),
      extends: preview('extends'),
      related: preview('related'),
      examples: preview('examples'),
      extendedBy: preview('extendedBy'),
      relatedFrom: preview('relatedFrom'),
    };
  }

  private obsidianUrl(topic: string, id: string): string {
    const file = `${topic}/${id.replace(/\.md$/, '')}`;
    return `obsidian://open?vault=${encodeURIComponent(this.deps.vaultName)}&file=${encodeURIComponent(file)}`;
  }
}
