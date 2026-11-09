import type { ResearchStep } from '@kb-chat/contracts';
import type { z } from 'zod';
import type { TrackShelf } from '../../ports/track-shelf.js';
import type { CatalogEntry, CatalogRegistry } from '../catalog/index.js';
import type { SourceBook } from './source-book.js';
import { quote, type AuthorshipLabels } from './tool-output.js';

export interface ToolContext {
  readonly topic: string;
  readonly book: SourceBook;
  /** How this collection names each authorship (KBC-049: its main author); set by the tools. */
  readonly labels?: AuthorshipLabels;
  /** The tracks this person may research (KBC-099 BR-4); without it, no track is seen. */
  readonly tracks?: TrackShelf;
}

/**
 * A text, or a track media.db and the person's permissions let this turn see (BR-4), in the
 * collection it is in (a sub-collection's, seen from its parent: KBC-101 FR-5).
 */
export function isVisible(
  entry: Pick<CatalogEntry, 'media' | 'home'>,
  { topic, tracks }: Pick<ToolContext, 'topic' | 'tracks'>,
): boolean {
  if (entry.media === null) return true;
  return (
    (tracks?.trackOf(entry.home?.topic ?? topic, entry.media) ?? null) !== null
  );
}

/** A tool call ready to run: the steps shown to the reader and the text for the model. */
export interface PreparedCall {
  /** One per thing done (a batch read shows one step per document); none when refused. */
  readonly steps: readonly ResearchStep[];
  run(): Promise<string>;
}

/** A refused call: no step, only the text that tells the model what to fix. */
export const failed = (text: string): PreparedCall => ({
  steps: [],
  run: async () => text,
});

/** The validated arguments, or the correction request for the model. */
export function parsedArgs<T extends z.ZodType>(
  schema: T,
  args: unknown,
): z.output<T> | string {
  const result = schema.safeParse(args);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `${issue.path.join('.') || 'argumentos'}: ${issue.message}`)
    .join('; ');
  return `Argumentos inválidos (${issues}). Corrija e chame de novo.`;
}

/** The [n] of "3", "[3]" or 3, or null for anything else (an id). */
export function refNumber(ref: string | number): number | null {
  if (typeof ref === 'number') return ref;
  const digits = /^\[?(\d+)\]?$/.exec(ref.trim())?.[1];
  return digits === undefined ? null : Number(digits);
}

/** A [n] already met this turn ("3", "[3]" or 3) or a document id of the topic. */
export function resolveEntry(
  catalog: CatalogRegistry,
  ref: string | number,
  context: ToolContext,
): CatalogEntry | null {
  const { topic, book } = context;
  const n = refNumber(ref);
  const id = n === null ? String(ref) : book.find(n)?.id;
  // The collection and its sub-collections (KBC-101 FR-5).
  const entry = id ? (catalog.scopeView(topic)?.entries.get(id) ?? null) : null;
  return entry && isVisible(entry, context) ? entry : null;
}

export const notFound = (ref: string | number): string =>
  `Documento ${typeof ref === 'number' ? `[${ref}]` : quote(ref)} não encontrado. Use o número [n] de um resultado de busca ou de uma ligação.`;
