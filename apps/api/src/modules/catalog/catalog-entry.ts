import {
  authorshipSchema,
  depthLevelSchema,
  genreSchema,
  relevanceSchema,
  type Authorship,
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
  /** A track (or recording) of the collection written by the app (KBC-099, ADR 0035 §5). */
  readonly media: CatalogMedia | null;
}

/** The `kb_chat_*` keys of a document the app rendered from a track (ADR 0035 §2). */
export interface CatalogMedia {
  readonly mediaId: string;
  readonly kind: 'track' | 'recording';
  readonly recordingId: string;
  readonly recordingTitle: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly ordinal: number | null;
  readonly total: number | null;
  readonly confidence: 'normal' | 'low';
  readonly fingerprint: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;

/**
 * The track behind a document, or null for a text. Only a document with a media id and a
 * fingerprint is one: a half-written header is read as a text, never as a broken track.
 */
function toMedia(data: Readonly<Record<string, unknown>>): CatalogMedia | null {
  const mediaId = toStringOrNull(data['kb_chat_media_id']);
  const recordingId = toStringOrNull(data['kb_chat_recording_id']);
  const fingerprint = toStringOrNull(data['kb_chat_fingerprint']);
  if (!mediaId || !UUID.test(mediaId) || !fingerprint) return null;
  const ordinal = toCount(data['kb_chat_track_ordinal']);
  const total = toCount(data['kb_chat_tracks_total']);
  return {
    mediaId,
    kind: data['kb_chat_media_kind'] === 'recording' ? 'recording' : 'track',
    recordingId: recordingId ?? mediaId,
    recordingTitle: toStringOrNull(data['kb_chat_recording_title']) ?? '',
    startMs: toCount(data['kb_chat_start_ms']) ?? 0,
    durationMs: toCount(data['kb_chat_duration_ms']) ?? 0,
    ordinal: ordinal && ordinal > 0 ? ordinal : null,
    total: total && total > 0 ? total : null,
    confidence: data['kb_chat_confidence'] === 'low' ? 'low' : 'normal',
    fingerprint,
  };
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

const WIKI_FOLDER = 'wiki/';

/**
 * KBC-020 (ADR 0015): the owner's `author_group` key decides; without a known value a
 * wiki article is a synthesis and anything else is unclassified (never guessed).
 */
function toAuthorship(id: string, value: unknown): Authorship {
  const parsed = authorshipSchema
    .extract(['mestre-laercio', 'outros-autores'])
    .safeParse(value);
  if (parsed.success) return parsed.data;
  return id.startsWith(WIKI_FOLDER) ? 'sintese' : 'nao-classificado';
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
  const media = toMedia(data);
  return {
    id,
    title: rawTitle ? toDisplayTitle(rawTitle) : titleFromId(id),
    summary: toStringOrNull(data['summary']),
    genre: toGenre(data['genre']),
    depth: toDepth(data['depth']),
    relevance: toRelevance(data['relevance']),
    concepts: toConcepts(data['concepts']),
    criterion: toStringOrNull(data['criterion']),
    origin: media ? 'audio' : toOrigin(sourcePath),
    entities: toNames(data['entities']),
    sourcePath,
    authorship: toAuthorship(id, data['author_group']),
    author: toStringOrNull(data['author']),
    relations: {
      exampleOf: toConcepts(data['example_of']),
      extends: toConcepts(data['extends']),
      related: toConcepts(data['related']),
    },
    media,
  };
}

/** A track document stays out of every search outside the conversation (ADR 0035 §8). */
export const isTrackEntry = (entry: Pick<CatalogEntry, 'media'>): boolean =>
  entry.media !== null;
