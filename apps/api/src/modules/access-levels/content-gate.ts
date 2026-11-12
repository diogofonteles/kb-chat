import {
  canSeeTopic,
  hasFeature,
  isMaster,
  type StoredPerson,
} from '../auth/index.js';
import type { CatalogRegistry, TopicCatalog } from '../catalog/index.js';
import type { ViewedCollection } from '../../ports/level-view.js';
import type { LevelDirectory, StoredLevel } from './level-directory.js';
import {
  CLOSED_VIEW,
  OPEN_VIEW,
  scaledView,
  type LevelView,
} from './level-view.js';

export interface ContentGateDeps {
  readonly directory: LevelDirectory;
  readonly catalog: CatalogRegistry;
  /** A media's level in media.db, for track documents (KBC-106); absent with media off. */
  readonly mediaLevelOf?: (mediaId: string) => string | null | undefined;
}

/**
 * The single place a person's view of content is made (ADR 0036 §6, §7): which levels of a
 * collection they see, from the scale of its top-level collection (a sub-collection uses its
 * parent's, by the catalog's tree, BR-1).
 */
/** The shares of one catalog load, for one state of the levels (NFR-1). */
interface Shares {
  readonly version: number;
  readonly byView: Map<string, number>;
}

export class ContentGate {
  private readonly shares = new WeakMap<ViewedCollection, Shares>();

  constructor(private readonly deps: ContentGateDeps) {}

  /** The top-level collection whose scale this one uses. */
  rootOf(topic: string): string {
    const parent = this.deps.catalog.get(topic)?.topic.parent;
    return parent && this.deps.catalog.get(parent) ? parent : topic;
  }

  scaleOf(topic: string): readonly StoredLevel[] {
    return this.deps.directory.scaleOf(this.rootOf(topic));
  }

  /** A sub-collection whose parent the catalog does not have: its scale is unknown. */
  private orphaned(topic: string): boolean {
    const parent = this.deps.catalog.get(topic)?.topic.parent;
    return !!parent && !this.deps.catalog.get(parent);
  }

  /** The person's view of `topic` and its sub-collections (masters see everything). */
  viewFor(person: StoredPerson, topic: string): LevelView {
    if (!isMaster(person) && this.orphaned(topic)) return CLOSED_VIEW;
    const root = this.rootOf(topic);
    const scale = this.deps.directory.scaleOf(root);
    if (scale.length === 0) return OPEN_VIEW;
    const rank = isMaster(person) ? 'all' : rankOfPerson(person, root, scale);
    const classifier = rank !== 'all' && classifies(person);
    const { directory } = this.deps;
    const key = `${root}:${rank}:${classifier ? 'classifier' : 'member'}`;
    return scaledView({
      scale,
      rank,
      classifier,
      placementsOf: (collection) => directory.placementsOf(collection),
      ...(this.deps.mediaLevelOf && { mediaLevelOf: this.deps.mediaLevelOf }),
      memo: (catalog, compute) => this.memo(catalog, key, compute),
    });
  }

  /**
   * The view a stored answer is re-checked with (KBC-110, ADR 0036 §8): nothing at all once
   * the person lost the collection (AC-6), else today's view of it.
   */
  storedViewFor(
    person: StoredPerson,
    topic: string,
    parentOf: (slug: string) => string | null,
  ): LevelView {
    if (!canSeeTopic(person, topic, parentOf)) return CLOSED_VIEW;
    return this.viewFor(person, topic);
  }

  /** The person's level, as an index in the scale (BR-5: absent or unknown is the lowest). */
  personRank(person: StoredPerson, topic: string): number {
    const root = this.rootOf(topic);
    return rankOfPerson(person, root, this.deps.directory.scaleOf(root));
  }

  /**
   * FR-8: the person's level code per top-level collection with a scale they see; none for
   * masters, who hold every level.
   */
  codesOf(
    person: StoredPerson,
    parentOf: (slug: string) => string | null,
  ): Record<string, string> {
    if (isMaster(person)) return {};
    const codes: Record<string, string> = {};
    for (const catalog of this.deps.catalog.topics()) {
      const slug = catalog.topic.slug;
      const scale = this.deps.directory.scaleOf(slug);
      if (scale.length === 0 || this.rootOf(slug) !== slug) continue;
      const seen = this.deps.catalog
        .scope(slug)
        .some((one) => canSeeTopic(person, one.topic.slug, parentOf));
      const level = scale[rankOfPerson(person, slug, scale)];
      if (seen && level) codes[slug] = level.code;
    }
    return codes;
  }

  /** Tracks follow their own level (KBC-106); an orphan's scale is unknown: closed. */
  tracksClosedByLevels(person: StoredPerson, topic: string): boolean {
    return !isMaster(person) && this.orphaned(topic);
  }

  /** The subjects and speakers of a scaled collection stay masters' (KBC-103 BR-10). */
  listsClosedByLevels(person: StoredPerson, topic: string): boolean {
    if (isMaster(person)) return false;
    return this.orphaned(topic) || this.scaleOf(topic).length > 0;
  }

  /** How many shares are kept for a catalog (the memo holds the current state only). */
  memoSize(catalog: TopicCatalog): number {
    return this.shares.get(catalog)?.byView.size ?? 0;
  }

  private memo(catalog: ViewedCollection, key: string, compute: () => number) {
    const { version } = this.deps.directory;
    const kept = this.shares.get(catalog);
    const current =
      kept?.version === version
        ? kept
        : { version, byView: new Map<string, number>() };
    this.shares.set(catalog, current);
    const cached = current.byView.get(key);
    if (cached !== undefined) return cached;
    const share = compute();
    current.byView.set(key, share);
    return share;
  }
}

/** Holds "Classificar nível de conteúdo" (KBC-107); masters hold it by their role. */
export const classifies = (person: StoredPerson): boolean =>
  hasFeature(person, 'content-levels');

function rankOfPerson(
  person: StoredPerson,
  root: string,
  scale: readonly StoredLevel[],
): number {
  const held = person.levels?.[root];
  const found = scale.findIndex((one) => one.id === held);
  return Math.max(0, found);
}
