import type { RelatedDocument, SeeAlsoGroupName } from '@kb-chat/contracts';
import type { CatalogEntry, RelationNames } from './catalog-entry.js';
import { copyKey } from './titles.js';

const CONCEPTS_FOLDER = 'wiki/concepts/';

/** Forward relation → the reverse group listed on the concept article. */
const REVERSE: Record<keyof RelationNames, SeeAlsoGroupName> = {
  exampleOf: 'examples',
  extends: 'extendedBy',
  related: 'relatedFrom',
};
const FORWARD_KEYS = Object.keys(REVERSE) as (keyof RelationNames)[];

const toRef = (entry: CatalogEntry): RelatedDocument => ({
  id: entry.id,
  title: entry.title,
  genre: entry.genre,
  depth: entry.depth,
  relevance: entry.relevance,
});

/** The concept a concept article is about, as written in its file name; null for sources. */
export const conceptOfArticle = (id: string): string | null =>
  id.startsWith(CONCEPTS_FOLDER)
    ? id.slice(CONCEPTS_FOLDER.length).replace(/\.md$/, '')
    : null;

/** Concept article name as kb links it, compared case-insensitively. */
const conceptKey = (name: string): string => name.trim().toLowerCase();
const conceptName = (id: string): string =>
  conceptKey(id.slice(CONCEPTS_FOLDER.length).replace(/\.md$/, ''));

/** One entry per title: copies of the same document and repeated links collapse (SL-25). */
function uniqueByCopy(refs: readonly RelatedDocument[]): RelatedDocument[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = copyKey(ref.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Resolves kb wikilinks to concept articles and indexes them both ways (KBC-003 BR-1).
 * A link whose article is not in the catalog is dropped.
 */
export class RelationIndex {
  private readonly conceptByName = new Map<string, CatalogEntry>();
  private readonly reverse = new Map<
    string,
    Map<SeeAlsoGroupName, RelatedDocument[]>
  >();

  constructor(entries: Iterable<CatalogEntry>) {
    const all = [...entries];
    for (const entry of all) {
      if (entry.id.startsWith(CONCEPTS_FOLDER))
        this.conceptByName.set(conceptName(entry.id), entry);
    }
    for (const entry of all) this.indexReverse(entry);
  }

  /** Concept articles by name as written, sorted: what a track can link to (KBC-069). */
  conceptNames(): string[] {
    return [...this.conceptByName.values()]
      .map((entry) =>
        entry.id.slice(CONCEPTS_FOLDER.length).replace(/\.md$/, ''),
      )
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }

  /** The groups shown on one document, each fully listed and without copies (callers page them). */
  groupsOf(
    entry: CatalogEntry,
  ): Record<SeeAlsoGroupName, readonly RelatedDocument[]> {
    const reverse = this.reverse.get(entry.id);
    return {
      exampleOf: uniqueByCopy(this.resolve(entry.relations.exampleOf)),
      extends: uniqueByCopy(this.resolve(entry.relations.extends)),
      related: uniqueByCopy(this.resolve(entry.relations.related)),
      examples: uniqueByCopy(reverse?.get('examples') ?? []),
      extendedBy: uniqueByCopy(reverse?.get('extendedBy') ?? []),
      relatedFrom: uniqueByCopy(reverse?.get('relatedFrom') ?? []),
    };
  }

  private resolve(names: readonly string[]): RelatedDocument[] {
    return names.flatMap((name) => {
      const concept = this.conceptByName.get(conceptKey(name));
      return concept ? [toRef(concept)] : [];
    });
  }

  private indexReverse(entry: CatalogEntry): void {
    for (const key of FORWARD_KEYS) {
      const targets = this.resolve(entry.relations[key]).filter(
        (target) => target.id !== entry.id,
      );
      for (const target of targets)
        this.addReverse(target.id, REVERSE[key], toRef(entry));
    }
  }

  private addReverse(
    conceptId: string,
    group: SeeAlsoGroupName,
    ref: RelatedDocument,
  ): void {
    const groups =
      this.reverse.get(conceptId) ??
      new Map<SeeAlsoGroupName, RelatedDocument[]>();
    groups.set(group, [...(groups.get(group) ?? []), ref]);
    this.reverse.set(conceptId, groups);
  }
}
