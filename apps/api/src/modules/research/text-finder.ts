import type { VaultReaderPort } from '../../ports/vault-reader.js';
import {
  splitFrontmatter,
  type CatalogEntry,
  type CatalogRegistry,
  type TopicCatalog,
} from '../catalog/index.js';
import { flatWithMap } from './flat-map.js';
import { countOccurrences, flatText, foldText } from './folded-text.js';

/**
 * Characters kept before and after the occurrence shown (KBC-011). The passage leans
 * forward: what a phrase like "cinco princípios" names usually follows it, so the list
 * often shows in the passage and the agent needs no read.
 */
const SNIPPET_BEFORE = 120;
const SNIPPET_AFTER = 320;
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

/** One matching document: how often each alternative occurs in it (KBC-017). */
export interface DocMatch {
  readonly entry: CatalogEntry;
  readonly occurrences: number;
  readonly phrases: readonly PhraseCount[];
}

/** Every matching document of a grep, ranked, with the totals (no cap, ADR 0013). */
export interface TextCount {
  readonly matches: readonly DocMatch[];
  readonly occurrences: number;
  /** Documents that passed the filter and were searched. */
  readonly scanned: number;
}

export interface CountQuery {
  readonly topic: string;
  /** Folded-distinct alternatives; none lists every document the filter accepts. */
  readonly phrases: readonly string[];
  readonly accept: (entry: CatalogEntry) => boolean;
}

/** One occurrence inside a document: where it is in the body and the text around it. */
export interface Occurrence {
  readonly phrase: string;
  /** Offset in the NFC body as read_document counts it; null inside the kb summary. */
  readonly offset: number | null;
  readonly context: string;
}

export interface DocOccurrences {
  /** Characters of the body (read_document's total). */
  readonly length: number;
  readonly items: readonly Occurrence[];
}

interface Counted {
  readonly doc: FoldedDocument;
  readonly occurrences: number;
  readonly phrases: readonly PhraseCount[];
}

/** Every non-overlapping position of each needle in the folded text, in reading order. */
function positionsOf(
  folded: string,
  needles: readonly Needle[],
): { readonly at: number; readonly phrase: string }[] {
  const found: { at: number; phrase: string }[] = [];
  for (const { phrase, folded: needle } of needles)
    for (
      let at = folded.indexOf(needle);
      at >= 0;
      at = folded.indexOf(needle, at + needle.length)
    )
      found.push({ at, phrase });
  return found.sort((a, b) => a.at - b.at);
}

const contextAround = (
  flat: string,
  { at, chars }: { at: number; chars: number },
): string => {
  const start = Math.max(0, at - Math.floor(chars / 3));
  const end = Math.min(flat.length, start + chars);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
};

const toNeedles = (phrases: readonly string[]): Needle[] =>
  phrases.map((phrase) => ({ phrase, folded: foldPhrase(phrase) }));

const byTitle = (a: CatalogEntry, b: CatalogEntry): number =>
  a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

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
  const start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(flat.length, at + needle.length + SNIPPET_AFTER);
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
    const counted = await this.count({ ...query, accept: () => true });
    if (!counted) return null;
    const hits = await Promise.all(
      counted.matches
        .slice(0, query.limit)
        .map((match) => this.toHit(query.topic, match)),
    );
    return {
      hits,
      documents: counted.matches.length,
      occurrences: counted.occurrences,
      scanned: counted.scanned,
    };
  }

  /**
   * Every document the filter accepts that holds any of the phrases, ranked by occurrences
   * (KBC-017): no cap, the caller pages. Without phrases, every accepted document by title.
   */
  async count(query: CountQuery): Promise<TextCount | null> {
    const catalog = this.deps.catalog.get(query.topic);
    if (!catalog) return null;
    if (query.phrases.length === 0) return this.listAccepted(catalog, query);
    const docs = (await this.corpus(catalog)).filter((doc) =>
      query.accept(doc.entry),
    );
    const needles = toNeedles(query.phrases);
    const counted = docs
      .map((doc) => countIn(doc, needles))
      .filter(({ occurrences }) => occurrences > 0)
      .sort(byRelevance);
    return {
      matches: counted.map(({ doc, occurrences, phrases }) => ({
        entry: doc.entry,
        occurrences,
        phrases,
      })),
      occurrences: counted.reduce((sum, c) => sum + c.occurrences, 0),
      scanned: docs.length,
    };
  }

  private listAccepted(catalog: TopicCatalog, query: CountQuery): TextCount {
    const entries = [...catalog.entries.values()]
      .filter((entry) => query.accept(entry))
      .sort(byTitle);
    return {
      matches: entries.map((entry) => ({ entry, occurrences: 0, phrases: [] })),
      occurrences: 0,
      scanned: entries.length,
    };
  }

  /** The passage around the first occurrence of a match's most frequent alternative. */
  async snippet(topic: string, match: DocMatch): Promise<string> {
    return (await this.toHit(topic, match)).snippet;
  }

  /**
   * Every occurrence of the phrases in one document, in reading order, with its offset in
   * the body (read_document's) and `chars` characters of context (find_text content mode).
   */
  async occurrencesIn(
    topic: string,
    entry: CatalogEntry,
    scan: { readonly phrases: readonly string[]; readonly chars: number },
  ): Promise<DocOccurrences | null> {
    const text = await this.deps.vault.readDocument(topic, entry.id);
    if (text === null) return null;
    const body = splitFrontmatter(text).body.normalize('NFC');
    const prefix = `${(entry.summary ?? '').normalize('NFC')}\n\n`;
    const { flat, map } = flatWithMap(prefix + body);
    const items = positionsOf(foldText(flat), toNeedles(scan.phrases)).map(
      ({ at, phrase }) => {
        const source = map[at] ?? 0;
        return {
          phrase,
          offset: source >= prefix.length ? source - prefix.length : null,
          context: contextAround(flat, { at, chars: scan.chars }),
        };
      },
    );
    return { length: body.length, items };
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
  private async toHit(topic: string, found: DocMatch): Promise<TextHit> {
    const { entry } = found;
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
