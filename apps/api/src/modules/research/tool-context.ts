import type { ResearchStep } from '@kb-chat/contracts';
import type { z } from 'zod';
import type { CatalogEntry, CatalogRegistry } from '../catalog/index.js';
import type { SourceBook } from './source-book.js';
import { quote } from './tool-output.js';

export interface ToolContext {
  readonly topic: string;
  readonly book: SourceBook;
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
  { topic, book }: ToolContext,
): CatalogEntry | null {
  const n = refNumber(ref);
  const id = n === null ? String(ref) : book.find(n)?.id;
  return id ? (catalog.get(topic)?.entries.get(id) ?? null) : null;
}

export const notFound = (ref: string | number): string =>
  `Documento ${typeof ref === 'number' ? `[${ref}]` : quote(ref)} não encontrado. Use o número [n] de um resultado de busca ou de uma ligação.`;
