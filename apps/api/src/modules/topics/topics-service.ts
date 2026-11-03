import {
  topicCreateSchema,
  topicSlugOf,
  type Topic,
  type TopicCreate,
  type TopicList,
  type TopicUpdate,
  topicUpdateSchema,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { CatalogRegistry, TopicCatalog } from '../catalog/index.js';
import type { CollectionRegistry } from './collection-registry.js';

/** Whoever creates or renames, and what they may see (KBC-048 BR-3). */
export interface CollectionActor {
  readonly personId: string;
  readonly email: string;
  readonly canSee: (slug: string) => boolean;
}

export interface TopicsServiceDeps {
  readonly catalog: CatalogRegistry;
  readonly registry: CollectionRegistry;
  /** Gives the creator access to the new collection (BR-5). */
  readonly grant: (personId: string, slug: string, by: string) => Promise<void>;
  readonly now?: () => Date;
}

export interface TopicsView {
  readonly preferredTopic?: string;
  /** Which collections the person sees (KBC-010); default: all. */
  readonly visible?: (slug: string) => boolean;
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });

const byTitle = (a: TopicCatalog, b: TopicCatalog): number =>
  collator.compare(a.topic.title, b.topic.title);

function toTopic(
  catalog: TopicCatalog,
  scope: readonly TopicCatalog[],
  canOpen: boolean,
): Topic {
  const { slug, title, parent, description } = catalog.topic;
  return {
    slug,
    title,
    parent: parent ?? null,
    description: description ?? '',
    canOpen,
    documentCount: canOpen
      ? scope.reduce((sum, one) => sum + one.entries.size, 0)
      : 0,
  };
}

/**
 * The collections as a tree (FR-4): top level by name, each followed by its sub-collections.
 * A parent the person cannot open is kept as the title of a group it has a visible child in.
 */
export function listTopics(
  { catalog }: Pick<TopicsServiceDeps, 'catalog'>,
  { preferredTopic, visible = () => true }: TopicsView = {},
): TopicList {
  const all = catalog.topics();
  const known = new Set(all.map((one) => one.topic.slug));
  const childrenOf = (slug: string) =>
    all.filter((one) => one.topic.parent === slug && visible(one.topic.slug));
  const items: Topic[] = [];
  const roots = all.filter(
    (one) => !one.topic.parent || !known.has(one.topic.parent),
  );
  for (const root of [...roots].sort(byTitle)) {
    const children = childrenOf(root.topic.slug).sort(byTitle);
    const canOpen = visible(root.topic.slug);
    if (!canOpen && children.length === 0) continue;
    items.push(toTopic(root, [root, ...children], canOpen));
    for (const child of children) items.push(toTopic(child, [child], true));
  }
  const defaultSlug = items.some(
    (item) => item.slug === preferredTopic && item.canOpen,
  )
    ? (preferredTopic ?? null)
    : null;
  return { items, defaultSlug };
}

/** Creating and renaming collections on the screen (KBC-048, ADR 0028). */
export class TopicsService {
  constructor(private readonly deps: TopicsServiceDeps) {}

  async create(actor: CollectionActor, input: TopicCreate): Promise<Topic> {
    const { title, description, parent } = topicCreateSchema.parse(input);
    const base = topicSlugOf(title);
    if (!base)
      throw new AppError('VALIDATION_FAILED', 'The name needs a letter');
    if (parent !== null) this.assertParent(actor, parent);
    const slug = parent === null ? base : `${parent}/${base}`;
    const { catalog, registry } = this.deps;
    await registry.create(
      {
        slug,
        title,
        description,
        parent,
        createdBy: actor.email,
        createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
      },
      (taken) => catalog.get(taken) !== undefined,
    );
    await this.deps.grant(actor.personId, slug, actor.email);
    await catalog.refresh(slug);
    return this.topicOf(slug);
  }

  /** New name or description; the slug, links and permissions stay (BR-4). */
  async rename(slug: string, input: TopicUpdate): Promise<Topic> {
    const names = topicUpdateSchema.parse(input);
    const current = this.require(slug).topic;
    await this.deps.registry.rename(
      {
        slug,
        title: current.title,
        description: current.description ?? '',
        parent: current.parent ?? null,
      },
      names,
    );
    await this.deps.catalog.refresh(slug);
    return this.topicOf(slug);
  }

  /** One level only (BR-2), inside a collection the person sees. */
  private assertParent(actor: CollectionActor, parent: string): void {
    const catalog = this.deps.catalog.get(parent);
    if (!catalog || !actor.canSee(parent))
      throw new AppError('VALIDATION_FAILED', 'Unknown parent collection');
    if (catalog.topic.parent || parent.includes('/'))
      throw new AppError(
        'VALIDATION_FAILED',
        'A sub-collection cannot hold another one',
      );
  }

  private require(slug: string): TopicCatalog {
    const catalog = this.deps.catalog.get(slug);
    if (!catalog)
      throw new AppError('TOPIC_NOT_FOUND', `Unknown topic ${slug}`);
    return catalog;
  }

  private topicOf(slug: string): Topic {
    return toTopic(this.require(slug), this.deps.catalog.scope(slug), true);
  }
}
