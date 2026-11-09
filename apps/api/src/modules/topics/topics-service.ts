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
import type { TrackShelf } from '../../ports/track-shelf.js';
import {
  isSeenDocument,
  type CatalogRegistry,
  type TopicCatalog,
} from '../catalog/index.js';
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

/** A collection's main author (KBC-049, ADR 0030), as the topic list shows it. */
export type MainAuthorOf = (slug: string) => Topic['mainAuthor'];

/** The authors' side of a collection that the topics change. */
export interface TopicAuthors {
  readonly mainOf: MainAuthorOf;
  /** Throws, writing nothing, when the collection cannot have that main author. */
  assertMainChoice(slug: string, author: string | null): void;
  setMain(slug: string, author: string | null): Promise<void>;
}

export interface TopicsServiceDeps {
  readonly catalog: CatalogRegistry;
  /** The main author of each collection (KBC-049); none when not given. */
  readonly authors?: TopicAuthors;
  readonly registry: CollectionRegistry;
  /** Gives the creator access to the new collection (BR-5). */
  readonly grant: (personId: string, slug: string, by: string) => Promise<void>;
  readonly now?: () => Date;
}

export interface TopicsView {
  readonly preferredTopic?: string;
  /** Which collections the person sees (KBC-010); default: all. */
  readonly visible?: (slug: string) => boolean;
  /** Which ones the person may rename (KBC-048); default: none. */
  readonly renamable?: (slug: string) => boolean;
  /** Each collection's main author (KBC-049); default: none. */
  readonly mainAuthorOf?: MainAuthorOf;
  /** The tracks the person sees as documents (KBC-101, C17); default: none, texts only. */
  readonly tracks?: TrackShelf | undefined;
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });

const byTitle = (a: TopicCatalog, b: TopicCatalog): number =>
  collator.compare(a.topic.title, b.topic.title);

type Counts = Pick<Topic, 'documentCount' | 'trackCount'>;

/** The documents of a scope this person sees, and the tracks among them (C17). */
function countsOf(
  scope: readonly TopicCatalog[],
  tracks: TrackShelf | undefined,
): Counts {
  const seen = scope.flatMap((one) =>
    [...one.entries.values()].filter((entry) =>
      isSeenDocument(entry, { topic: one.topic.slug, tracks }),
    ),
  );
  return {
    documentCount: seen.length,
    trackCount: seen.filter((entry) => entry.media !== null).length,
  };
}

const NOTHING: Counts = { documentCount: 0, trackCount: 0 };

function toTopic(
  catalog: TopicCatalog,
  counts: Counts,
  access: Pick<Topic, 'canOpen' | 'canRename' | 'mainAuthor'>,
): Topic {
  const { slug, title, parent, description } = catalog.topic;
  return {
    slug,
    title,
    parent: parent ?? null,
    description: description ?? '',
    ...access,
    // A track is a document of its collection for who sees it (KBC-101, owner decision C17).
    ...(access.canOpen ? counts : NOTHING),
  };
}

/** One parent and its visible sub-collections, as list rows (the parent first). */
function branchOf(
  root: TopicCatalog,
  children: readonly TopicCatalog[],
  view: Required<Pick<TopicsView, 'visible' | 'renamable' | 'mainAuthorOf'>> &
    Pick<TopicsView, 'tracks'>,
): Topic[] {
  const canOpen = view.visible(root.topic.slug);
  if (!canOpen && children.length === 0) return [];
  return [
    // Counted only for who opens the parent: nothing of media.db is read for a closed one.
    toTopic(
      root,
      canOpen ? countsOf([root, ...children], view.tracks) : NOTHING,
      {
        canOpen,
        canRename: canOpen && view.renamable(root.topic.slug),
        mainAuthor: view.mainAuthorOf(root.topic.slug),
      },
    ),
    ...children.map((child) =>
      toTopic(child, countsOf([child], view.tracks), {
        canOpen: true,
        canRename: view.renamable(child.topic.slug),
        mainAuthor: view.mainAuthorOf(child.topic.slug),
      }),
    ),
  ];
}

type BranchView = Parameters<typeof branchOf>[2];

/** What the view leaves out: all seen, none renamable, no main author, texts only. */
const withDefaults = (
  view: Omit<TopicsView, 'preferredTopic'>,
): BranchView => ({
  visible: view.visible ?? (() => true),
  renamable: view.renamable ?? (() => false),
  mainAuthorOf: view.mainAuthorOf ?? (() => null),
  tracks: view.tracks,
});

/**
 * The collections as a tree (FR-4): top level by name, each followed by its sub-collections.
 * A parent the person cannot open is kept as the title of a group it has a visible child in.
 */
export function listTopics(
  { catalog }: Pick<TopicsServiceDeps, 'catalog'>,
  { preferredTopic, ...given }: TopicsView = {},
): TopicList {
  const view = withDefaults(given);
  const { visible } = view;
  const all = catalog.topics();
  const known = new Set(all.map((one) => one.topic.slug));
  const roots = all
    .filter((one) => !one.topic.parent || !known.has(one.topic.parent))
    .sort(byTitle);
  const childrenOf = (root: TopicCatalog) =>
    all
      .filter(
        (one) =>
          one.topic.parent === root.topic.slug && visible(one.topic.slug),
      )
      .sort(byTitle);
  const items = roots.flatMap((root) => branchOf(root, childrenOf(root), view));
  const opens = items.some(
    (item) => item.slug === preferredTopic && item.canOpen,
  );
  return { items, defaultSlug: opens ? (preferredTopic ?? null) : null };
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
        createdFor: actor.personEmail,
        createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
      },
      (taken) => this.isTaken(taken),
    );
    await catalog.refresh(slug);
    try {
      await this.deps.grant(actor.personId, slug, actor.email);
    } catch (err) {
      // Nothing half made (NFR-2): a collection its creator cannot see is undone; the
      // original failure is the one reported, whatever the undo does.
      await this.undo(slug).catch(() => undefined);
      throw err;
    }
    return this.topicOf(slug);
  }

  private async undo(slug: string): Promise<void> {
    await this.deps.registry.remove(slug);
    await this.deps.catalog.refresh(slug);
  }

  /**
   * New name, description or main author; the slug, links and permissions stay (BR-4).
   * Masters change any collection; others only the ones they created (a shared one changes
   * for everyone). The main author is one of the collection's authors (KBC-049 FR-2).
   */
  async rename(
    actor: CollectionActor,
    slug: string,
    input: TopicUpdate,
  ): Promise<Topic> {
    const { mainAuthor, ...names } = topicUpdateSchema.parse(input);
    const current = this.require(slug).topic;
    await this.assertMayRename(actor, slug);
    if (names.title !== undefined)
      this.assertFreeName(names.title, current.parent ?? null, slug);
    // Everything is checked before the first write: a refused change changes nothing.
    if (mainAuthor !== undefined)
      this.authors().assertMainChoice(slug, mainAuthor);
    if (names.title !== undefined || names.description !== undefined) {
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
    }
    if (mainAuthor !== undefined)
      await this.authors().setMain(slug, mainAuthor);
    return this.topicOf(slug);
  }

  private authors(): TopicAuthors {
    if (!this.deps.authors)
      throw new AppError('VALIDATION_FAILED', 'Authors are not available');
    return this.deps.authors;
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
    if (!(await this.renamableBy(actor))(slug))
      throw new AppError(
        'FORBIDDEN',
        'Only its creator or a master renames it',
      );
  }

  /**
   * Which collections this person may rename: a master any, others the ones created by them
   * or for them (a master acting as them, ADR 0027). Shown as `canRename` in the list.
   */
  async renamableBy(
    actor: CollectionActor,
  ): Promise<(slug: string) => boolean> {
    if (actor.isMaster) return () => true;
    const own = new Set(
      (await this.deps.registry.list())
        .filter((one) =>
          [one.createdBy, one.createdFor].some(
            (who) => who === actor.personEmail || who === actor.email,
          ),
        )
        .map((one) => one.slug),
    );
    return (slug) => own.has(slug);
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
    // Texts only: the list the screen reloads counts the tracks each person sees.
    return toTopic(
      this.require(slug),
      countsOf(this.deps.catalog.scope(slug), undefined),
      {
        canOpen: true,
        canRename: true,
        mainAuthor: this.deps.authors?.mainOf(slug) ?? null,
      },
    );
  }
}
