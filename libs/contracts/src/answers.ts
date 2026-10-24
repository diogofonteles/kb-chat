import { z } from 'zod';
import {
  documentRefSchema,
  searchFiltersSchema,
  searchModeSchema,
} from './search.js';

/** The question and the search it is grounded on (same as the result list it sits above). */
export const answerRequestSchema = z.strictObject({
  q: z.string().trim().min(1).max(500),
  mode: searchModeSchema.default('all'),
  filters: searchFiltersSchema.default(() => ({
    concepts: [],
    genres: [],
    depths: [],
    relevances: [],
  })),
});
export type AnswerRequest = z.input<typeof answerRequestSchema>;

export const answerEstimateSchema = z.object({
  /** Upper bound in US$ for one answer with the current passages and the maximum output. */
  usd: z.number().nonnegative(),
  model: z.string(),
  passages: z.number().int().nonnegative(),
});
export type AnswerEstimate = z.infer<typeof answerEstimateSchema>;

/** A numbered source: [n] in the answer text points to sources[n - 1]. */
export const answerSourceSchema = documentRefSchema.extend({
  n: z.number().int().positive(),
});
export type AnswerSource = z.infer<typeof answerSourceSchema>;

/**
 * Server-sent events of POST /topics/:topic/answers (one JSON object per `data:` line):
 * sources first, then text tokens, then done with the real cost, or error.
 */
export const answerEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sources'),
    sources: z.array(answerSourceSchema),
  }),
  z.object({ type: z.literal('token'), text: z.string() }),
  z.object({
    type: z.literal('done'),
    usd: z.number().nonnegative(),
    model: z.string(),
    interrupted: z.boolean(),
  }),
  z.object({ type: z.literal('error'), code: z.string() }),
]);
export type AnswerEvent = z.infer<typeof answerEventSchema>;

export const spendTodaySchema = z.object({
  usd: z.number().nonnegative(),
  capUsd: z.number().nonnegative(),
  /** False when OPENROUTER_API_KEY is not set on the server. */
  configured: z.boolean(),
});
export type SpendToday = z.infer<typeof spendTodaySchema>;
