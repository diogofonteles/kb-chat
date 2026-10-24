import {
  depthLevelSchema,
  genreSchema,
  relevanceSchema,
  type DepthLevel,
  type DocumentFacets,
  type Genre,
  type Relevance,
} from '@kb-chat/contracts';
import { titleFromId, toDisplayTitle } from './titles.js';

export interface CatalogEntry extends DocumentFacets {
  readonly id: string;
  readonly title: string;
  readonly summary: string | null;
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

function toConcepts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value
    .filter((item): item is string => typeof item === 'string')
    .map(toConceptName);
  return [...new Set(names.filter(Boolean))];
}

/** Builds the catalog entry of one document from its parsed frontmatter. */
export function toCatalogEntry(
  id: string,
  data: Readonly<Record<string, unknown>>,
): CatalogEntry {
  const rawTitle = toStringOrNull(data['title']);
  return {
    id,
    title: rawTitle ? toDisplayTitle(rawTitle) : titleFromId(id),
    summary: toStringOrNull(data['summary']),
    genre: toGenre(data['genre']),
    depth: toDepth(data['depth']),
    relevance: toRelevance(data['relevance']),
    concepts: toConcepts(data['concepts']),
  };
}
