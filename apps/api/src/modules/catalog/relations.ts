import type { DocumentRef, SeeAlsoGroupName } from '@kb-chat/contracts';
import type { CatalogEntry, RelationNames } from './catalog-entry.js';

const CONCEPTS_FOLDER = 'wiki/concepts/';

/** Forward relation → the reverse group listed on the concept article. */
const REVERSE: Record<keyof RelationNames, SeeAlsoGroupName> = {
  exampleOf: 'examples',
  extends: 'extendedBy',
  related: 'relatedFrom',
};
const FORWARD_KEYS = Object.keys(REVERSE) as (keyof RelationNames)[];

const toRef = (entry: CatalogEntry): DocumentRef => ({
  id: entry.id,
  title: entry.title,
});

/** Concept article name as kb links it: the file name without folder and extension. */
const conceptName = (id: string): string =>
  id.slice(CONCEPTS_FOLDER.length).replace(/\.md$/, '');

/**
 * Resolves kb wikilinks to concept articles and indexes them both ways (KBC-003 BR-1).
 * A link whose article is not in the catalog is dropped.
 */
export class RelationIndex {
  private readonly conceptByName = new Map<string, CatalogEntry>();
  private readonly reverse = new Map<
    string,
    Map<SeeAlsoGroupName, DocumentRef[]>
  >();

  constructor(entries: Iterable<CatalogEntry>) {
    const all = [...entries];
    for (const entry of all) {
      if (entry.id.startsWith(CONCEPTS_FOLDER))
        this.conceptByName.set(conceptName(entry.id), entry);
    }
    for (const entry of all) this.indexReverse(entry);
  }

  /** The groups shown on one document, each fully listed (callers page them). */
  groupsOf(
    entry: CatalogEntry,
  ): Record<SeeAlsoGroupName, readonly DocumentRef[]> {
    const reverse = this.reverse.get(entry.id);
    return {
      exampleOf: this.resolve(entry.relations.exampleOf),
      extends: this.resolve(entry.relations.extends),
      related: this.resolve(entry.relations.related),
      examples: reverse?.get('examples') ?? [],
      extendedBy: reverse?.get('extendedBy') ?? [],
      relatedFrom: reverse?.get('relatedFrom') ?? [],
    };
  }

  private resolve(names: readonly string[]): DocumentRef[] {
    return names.flatMap((name) => {
      const concept = this.conceptByName.get(name);
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
    ref: DocumentRef,
  ): void {
    const groups =
      this.reverse.get(conceptId) ?? new Map<SeeAlsoGroupName, DocumentRef[]>();
    groups.set(group, [...(groups.get(group) ?? []), ref]);
    this.reverse.set(conceptId, groups);
  }
}
