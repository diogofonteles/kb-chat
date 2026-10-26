import {
  depthLevelSchema,
  genreSchema,
  relevanceSchema,
  type DepthLevel,
  type DocumentFacets,
  type DocumentOrigin,
  type Genre,
  type Relevance,
} from '@kb-chat/contracts';
import { titleFromId, toDisplayTitle } from './titles.js';

/** Concept names a document points to through kb's relation lists (unresolved). */
export interface RelationNames {
  readonly exampleOf: readonly string[];
  readonly extends: readonly string[];
  readonly related: readonly string[];
}

export interface CatalogEntry extends DocumentFacets {
  readonly id: string;
  readonly title: string;
  readonly summary: string | null;
  readonly criterion: string | null;
  readonly origin: DocumentOrigin;
  readonly relations: RelationNames;
  /** kb's `entities`: authors, people and works the document names (KBC-017 filters). */
  readonly entities: readonly string[];
  /** kb's `source_path`: where the text came from (its origin folder, KBC-017). */
  readonly sourcePath: string | null;
}

const WIKILINK = /^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/;

/** "[[hermetismo/wiki/concepts/Cabala]]" and "Cabala" both become "Cabala". */
export function toConceptName(raw: string): string {
  const inner = WIKILINK.exec(raw.trim())?.[1] ?? raw.trim();
  return (inner.split('/').pop() ?? inner).trim();
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toGenre(value: unknown): Genre | null {
  const parsed = genreSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function toRelevance(value: unknown): Relevance | null {
  const parsed = relevanceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function toDepth(value: unknown): DepthLevel | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  const parsed = depthLevelSchema.safeParse(
    Math.min(3, Math.max(0, Math.floor(value))),
  );
  return parsed.success ? parsed.data : null;
}

/** Converted audio and OCR texts carry their pipeline folder in kb's `source_path`. */
function toOrigin(sourcePath: string | null): DocumentOrigin {
  if (!sourcePath) return null;
  if (/(^|\/)audio(-vad)?\//.test(sourcePath)) return 'audio';
  if (/(^|\/)ocr\//.test(sourcePath)) return 'ocr';
  return null;
}

function toConcepts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value
    .filter((item): item is string => typeof item === 'string')
    .map(toConceptName);
  return [...new Set(names.filter(Boolean))];
}

/** A list of names as written, wikilink brackets removed, without blanks or repeats. */
function toNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => /^\[\[([^\]|#]+)/.exec(item.trim())?.[1] ?? item)
    .map((item) => item.trim());
  return [...new Set(names.filter(Boolean))];
}

/** Builds the catalog entry of one document from its parsed frontmatter. */
export function toCatalogEntry(
  id: string,
  data: Readonly<Record<string, unknown>>,
): CatalogEntry {
  const rawTitle = toStringOrNull(data['title']);
  const sourcePath = toStringOrNull(data['source_path']);
  return {
    id,
    title: rawTitle ? toDisplayTitle(rawTitle) : titleFromId(id),
    summary: toStringOrNull(data['summary']),
    genre: toGenre(data['genre']),
    depth: toDepth(data['depth']),
    relevance: toRelevance(data['relevance']),
    concepts: toConcepts(data['concepts']),
    criterion: toStringOrNull(data['criterion']),
    origin: toOrigin(sourcePath),
    entities: toNames(data['entities']),
    sourcePath,
    relations: {
      exampleOf: toConcepts(data['example_of']),
      extends: toConcepts(data['extends']),
      related: toConcepts(data['related']),
    },
  };
}
