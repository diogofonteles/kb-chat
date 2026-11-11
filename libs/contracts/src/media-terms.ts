import { z } from 'zod';

/** Whisper's prompt budget (ADR 0023 §3, KBC-040 BR-2). */
export const TERMS_TOKEN_LIMIT = 224;
export const MAX_TERM_LENGTH = 100;
export const MAX_TERMS = 500;

/**
 * One term as the prompt can carry it: a comma would split it, and whisper's tokenizer
 * refuses text that looks like a special token (`<|…|>`), which would fail every job.
 */
export const TERM_PATTERN = /^[^,<>|\p{Cc}]+$/u;

export const termSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TERM_LENGTH)
  .regex(TERM_PATTERN);

const termsSchema = z.array(termSchema).min(1).max(MAX_TERMS);

/** POST /api/v1/media/terms/measure: what a list would take of the prompt. */
export const measureTermsRequestSchema = z.object({ terms: termsSchema });
export type MeasureTermsRequest = z.infer<typeof measureTermsRequestSchema>;

export const termsUsageSchema = z.object({
  tokens: z.number().int().min(0),
  limit: z.number().int().min(1),
});
export type TermsUsage = z.infer<typeof termsUsageSchema>;

/** PUT /api/v1/media/terms: the whole list, on top of the version the person edited. */
export const saveTermsRequestSchema = z.object({
  baseVersion: z.number().int().min(1),
  terms: termsSchema,
});
export type SaveTermsRequest = z.infer<typeof saveTermsRequestSchema>;

/** One saved version (BR-1); no author: the pilot's list, from before the screen. */
export const termVersionSchema = z.object({
  version: z.number().int().min(1),
  createdAt: z.iso.datetime(),
  authorName: z.string().nullable(),
  termCount: z.number().int().min(0),
});
export type TermVersion = z.infer<typeof termVersionSchema>;

/** GET /api/v1/media/terms: the current list, its use of the limit and its versions. */
export const termListSchema = termsUsageSchema.extend({
  version: z.number().int().min(1),
  terms: z.array(z.string().min(1)),
  createdAt: z.iso.datetime(),
  authorName: z.string().nullable(),
  /** Newest first. */
  versions: z.array(termVersionSchema),
});
export type TermList = z.infer<typeof termListSchema>;

/** `details` of a TERMS_OVER_LIMIT error (AC-3). */
export const termsOverLimitSchema = termsUsageSchema;

/** The list a transcript was made with (FR-4). */
export const transcriptTermListSchema = z.object({
  version: z.number().int().min(1),
  createdAt: z.iso.datetime(),
});

/**
 * Lines as a list: spaces tidied, empty lines gone and a repeated term kept once, the first
 * spelling winning. Case does not make two terms: the prompt would only spend tokens on it.
 */
export function normalizeTerms(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  return lines
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((term) => {
      const key = term.toLocaleLowerCase('pt-BR');
      if (term === '' || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
