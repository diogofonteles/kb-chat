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
  type CatalogMedia,
  type CatalogRegistry,
  type ScopeView,
  type TopicCatalog,
} from '../catalog/index.js';
import type { LevelView } from '../access-levels/index.js';

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

/**
 * Who reads, as "Veja também" needs it (KBC-101 BR-5): a track linked by kb is listed only
 * to who would see it in the research, while media.db confirms it. Without it, texts only.
 */
export interface DocumentReader {
  readonly seesTrack?: (topic: string, media: CatalogMedia) => boolean;
  /** What the reader's level reaches (KBC-103): required, never open by default. */
  readonly level: LevelView;
}

/** The refs this reader may see: texts, and the tracks they would research. */
function seenBy<T extends { id: string }>(
  { catalog, view }: Located,
  { refs, reader }: { refs: readonly T[]; reader: DocumentReader },
): T[] {
  return refs
    .filter((ref) => {
      const entry = catalog.entries.get(ref.id);
      if (!entry) return true;
      // Above the reader's level, a related document is not there (KBC-103 BR-8).
      if (!reader.level.allows(catalog.topic.slug, entry)) return false;
      if (!entry.media) return true;
      return reader.seesTrack?.(catalog.topic.slug, entry.media) ?? false;
    })
    .map((ref) => ({ ...ref, id: view.idOf(catalog.topic.slug, ref.id) }));
}

/** A document, its collection and the scope it was named from (FR-5). */
interface Located {
  readonly view: ScopeView;
  readonly catalog: TopicCatalog;
  readonly entry: CatalogEntry;
}

/** The level badge, for whoever manages levels in a scaled collection (T3). */
const levelBadge = (level: LevelView, collection: string, id: string) => {
  const found = level.levelOf(collection, id);
  return found === undefined ? {} : { level: found };
};

export class DocumentsService {
  constructor(private readonly deps: DocumentsServiceDeps) {}

  async getDocument(
    topic: string,
    id: string,
    reader: DocumentReader,
  ): Promise<KbDocument> {
    const located = this.requireEntry(topic, id, reader.level);
    const { catalog, entry } = located;
    const text = await this.readText(located);
    return {
      id,
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
      obsidianUrl: this.obsidianUrl(catalog.topic.slug, entry.id),
      seeAlso: this.seeAlso(located, reader),
      body: splitFrontmatter(text).body.trim(),
      ...levelBadge(reader.level, catalog.topic.slug, entry.id),
    };
  }

  relationPage(
    topic: string,
    id: string,
    { query, reader }: { query: RelationPageQuery; reader: DocumentReader },
  ): RelationPage {
    const located = this.requireEntry(topic, id, reader.level);
    const { catalog, entry } = located;
    const all = seenBy(located, {
      refs: catalog.relations.groupsOf(entry)[query.group],
      reader,
    });
    const end = Math.min(query.offset + query.limit, all.length);
    return {
      items: all.slice(query.offset, end),
      total: all.length,
      nextOffset: end < all.length ? end : null,
    };
  }

  /** A sub-collection's document named from its parent is read in its own folder (FR-5). */
  private async readText({ catalog, entry }: Located): Promise<string> {
    const text = await this.deps.vault.readDocument(
      catalog.topic.slug,
      entry.id,
    );
    if (text === null)
      throw new AppError('DOCUMENT_NOT_FOUND', 'Document not found');
    return text;
  }

  private requireEntry(topic: string, id: string, level: LevelView): Located {
    if (!isSafeDocumentId(id))
      throw new AppError('VALIDATION_FAILED', 'Invalid document id');
    const view = this.deps.catalog.scopeView(topic);
    if (!view) throw new AppError('TOPIC_NOT_FOUND', `Unknown topic ${topic}`);
    // A research source in a sub-collection is named by its id from the parent (FR-5).
    const found = view.entries.get(id);
    const catalog = found ? view.catalogOf(found) : view.root;
    const entry = found && catalog.entries.get(found.home?.id ?? id);
    // A track's Markdown is for kb and the agent, never shown to people (ADR 0035 §7); a
    // document above the reader's level answers like one that does not exist (KBC-103 BR-7).
    if (
      !entry ||
      isTrackEntry(entry) ||
      !level.allows(catalog.topic.slug, entry)
    )
      throw new AppError('DOCUMENT_NOT_FOUND', 'Document not found');
    return { view, catalog, entry };
  }

  private seeAlso(located: Located, reader: DocumentReader): SeeAlso {
    const groups = located.catalog.relations.groupsOf(located.entry);
    const preview = (group: SeeAlsoGroupName) => {
      const refs = seenBy(located, { refs: groups[group], reader });
      return { items: refs.slice(0, SEE_ALSO_PREVIEW), total: refs.length };
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
