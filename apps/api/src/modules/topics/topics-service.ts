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
  /** The person whose view this is: they get access to what they create (BR-5). */
  readonly personId: string;
  readonly personEmail: string;
  readonly isMaster: boolean;
  /** Who really did it, for the records: the master when acting as the person (ADR 0027). */
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
    this.assertFreeName(title, parent);
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
      (taken) => this.isTaken(taken),
    );
    await catalog.refresh(slug);
    try {
      await this.deps.grant(actor.personId, slug, actor.email);
    } catch (err) {
      // Nothing half made (NFR-2): a collection its creator cannot see is undone.
      await registry.remove(slug);
      await catalog.refresh(slug);
      throw err;
    }
    return this.topicOf(slug);
  }

  /**
   * New name or description; the slug, links and permissions stay (BR-4). Masters rename any
   * collection; others only the ones they created (a shared one is renamed for everyone).
   */
  async rename(
    actor: CollectionActor,
    slug: string,
    input: TopicUpdate,
  ): Promise<Topic> {
    const names = topicUpdateSchema.parse(input);
    const current = this.require(slug).topic;
    await this.assertMayRename(actor, slug);
    if (names.title !== undefined)
      this.assertFreeName(names.title, current.parent ?? null, slug);
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

  /**
   * A slug is taken by a collection, or by a vault folder that holds topics under it (a
   * new "harness" must never become the parent of the vault's "harness/goclaw").
   */
  private isTaken(slug: string): boolean {
    return this.deps.catalog
      .topics()
      .some(
        ({ topic }) => topic.slug === slug || topic.slug.startsWith(`${slug}/`),
      );
  }

  /** Two collections side by side never share a name (the selector could not tell them apart). */
  private assertFreeName(
    title: string,
    parent: string | null,
    except?: string,
  ): void {
    const name = topicSlugOf(title);
    const clash = this.deps.catalog
      .topics()
      .some(
        ({ topic }) =>
          topic.slug !== except &&
          (topic.parent ?? null) === parent &&
          topicSlugOf(topic.title) === name,
      );
    if (clash) throw new AppError('TOPIC_EXISTS', 'Name taken here');
  }

  private async assertMayRename(
    actor: CollectionActor,
    slug: string,
  ): Promise<void> {
    if (actor.isMaster) return;
    const mine = (await this.deps.registry.list()).some(
      (one) =>
        one.slug === slug &&
        (one.createdBy === actor.personEmail || one.createdBy === actor.email),
    );
    if (!mine)
      throw new AppError(
        'FORBIDDEN',
        'Only its creator or a master renames it',
      );
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
