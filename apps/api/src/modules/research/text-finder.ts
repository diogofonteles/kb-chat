import type { VaultReaderPort } from '../../ports/vault-reader.js';
import {
  splitFrontmatter,
  type CatalogEntry,
  type CatalogRegistry,
  type TopicCatalog,
} from '../catalog/index.js';
import { countOccurrences, flatText, foldText } from './folded-text.js';

/** Characters of text kept on each side of the occurrence shown. */
const SNIPPET_CHARS = 200;
const READ_CONCURRENCY = 64;

export interface TextFinderDeps {
  readonly catalog: CatalogRegistry;
  readonly vault: VaultReaderPort;
}

interface FoldedDocument {
  readonly entry: CatalogEntry;
  readonly folded: string;
}

export interface PhraseCount {
  readonly phrase: string;
  readonly count: number;
}

export interface TextHit {
  readonly entry: CatalogEntry;
  readonly occurrences: number;
  /** The alternatives found in this document, with their counts. */
  readonly phrases: readonly PhraseCount[];
  /** The text around the first occurrence of the most frequent alternative. */
  readonly snippet: string;
}

export interface TextSearch {
  readonly hits: readonly TextHit[];
  /** Documents with at least one occurrence (hits holds the first `limit`). */
  readonly documents: number;
  readonly occurrences: number;
  readonly scanned: number;
}

export interface TextQuery {
  readonly topic: string;
  readonly phrases: readonly string[];
  readonly limit: number;
}

interface Counted {
  readonly doc: FoldedDocument;
  readonly occurrences: number;
  readonly phrases: readonly PhraseCount[];
}

/** The searchable text of a document: its kb summary and its body. */
const searchableText = (entry: CatalogEntry, text: string): string =>
  flatText(`${entry.summary ?? ''}\n\n${splitFrontmatter(text).body}`);

/** Phrase as find_text compares it (folded, one line). */
export const foldPhrase = (phrase: string): string =>
  foldText(flatText(phrase));

interface Needle {
  readonly phrase: string;
  readonly folded: string;
}

function countIn(doc: FoldedDocument, needles: readonly Needle[]): Counted {
  const counts = needles
    .map(({ phrase, folded }) => ({
      phrase,
      count: countOccurrences(doc.folded, folded).count,
    }))
    .filter(({ count }) => count > 0)
    .sort((a, b) => b.count - a.count);
  const occurrences = counts.reduce((sum, { count }) => sum + count, 0);
  return { doc, occurrences, phrases: counts };
}

const byRelevance = (a: Counted, b: Counted): number =>
  b.occurrences - a.occurrences ||
  b.phrases.length - a.phrases.length ||
  a.doc.entry.title.localeCompare(b.doc.entry.title);

function snippetOf(flat: string, phrase: string): string {
  const needle = foldPhrase(phrase);
  const at = foldText(flat).indexOf(needle);
  if (at < 0) return '';
  const start = Math.max(0, at - SNIPPET_CHARS);
  const end = Math.min(flat.length, at + needle.length + SNIPPET_CHARS);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * Literal, accent- and case-insensitive phrase search over the body and summary of every
 * cataloged document of a topic (find_text, ADR 0006) — what `grep` gives a person. The
 * folded text of a topic is built once, on first use, and kept per catalog load: a reload
 * creates new catalog objects, so the cache (keyed by them) is rebuilt with it.
 */
export class TextFinder {
  private readonly corpora = new WeakMap<
    TopicCatalog,
    Promise<readonly FoldedDocument[]>
  >();

  constructor(private readonly deps: TextFinderDeps) {}

  /** Builds the topic's folded text ahead of the first search. */
  async warm(topic: string): Promise<void> {
    const catalog = this.deps.catalog.get(topic);
    if (catalog) await this.corpus(catalog);
  }

  /** Documents ranked by occurrences of any of the phrases; null for an unknown topic. */
  async find(query: TextQuery): Promise<TextSearch | null> {
    const catalog = this.deps.catalog.get(query.topic);
    if (!catalog) return null;
    const docs = await this.corpus(catalog);
    const needles = query.phrases.map((phrase) => ({
      phrase,
      folded: foldPhrase(phrase),
    }));
    const counted = docs
      .map((doc) => countIn(doc, needles))
      .filter(({ occurrences }) => occurrences > 0)
      .sort(byRelevance);
    const hits = await Promise.all(
      counted
        .slice(0, query.limit)
        .map((found) => this.toHit(query.topic, found)),
    );
    return {
      hits,
      documents: counted.length,
      occurrences: counted.reduce((sum, c) => sum + c.occurrences, 0),
      scanned: docs.length,
    };
  }

  private corpus(catalog: TopicCatalog): Promise<readonly FoldedDocument[]> {
    const cached = this.corpora.get(catalog);
    if (cached) return cached;
    const built = this.build(catalog);
    this.corpora.set(catalog, built);
    built.catch(() => this.corpora.delete(catalog));
    return built;
  }

  private async build(catalog: TopicCatalog): Promise<FoldedDocument[]> {
    const entries = [...catalog.entries.values()];
    const docs: FoldedDocument[] = [];
    for (let start = 0; start < entries.length; start += READ_CONCURRENCY) {
      const chunk = entries.slice(start, start + READ_CONCURRENCY);
      const read = await Promise.all(
        chunk.map((entry) => this.fold(catalog.topic.slug, entry)),
      );
      docs.push(...read.filter((doc) => doc !== null));
    }
    return docs;
  }

  private async fold(
    topic: string,
    entry: CatalogEntry,
  ): Promise<FoldedDocument | null> {
    const text = await this.deps.vault.readDocument(topic, entry.id);
    if (text === null) return null;
    return { entry, folded: foldText(searchableText(entry, text)) };
  }

  /** The snippet comes from the file again: only the folded text stays in memory. */
  private async toHit(topic: string, found: Counted): Promise<TextHit> {
    const { entry } = found.doc;
    const text = await this.deps.vault.readDocument(topic, entry.id);
    const best = found.phrases[0]?.phrase ?? '';
    return {
      entry,
      occurrences: found.occurrences,
      phrases: found.phrases,
      snippet:
        text === null ? '' : snippetOf(searchableText(entry, text), best),
    };
  }
}
