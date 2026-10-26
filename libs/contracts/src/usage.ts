import { z } from 'zod';
import { searchModeSchema } from './search.js';

/** Start-screen suggestions: the largest subjects of a collection (KBC-006 BR-1). */
export const MAX_SUGGESTIONS = 6;

export const suggestionListSchema = z.object({
  items: z.array(
    z.object({
      concept: z.string().min(1),
      count: z.number().int().positive(),
    }),
  ),
});
export type SuggestionList = z.infer<typeof suggestionListSchema>;

/**
 * Why a search ran: only typed questions, suggestions and "try in another mode" are new
 * searches in the report; refines and retries re-run the same one (restores are not logged).
 */
export const SEARCH_ORIGINS = [
  'typed',
  'suggestion',
  'mode',
  'refine',
  'retry',
] as const;
export const searchOriginSchema = z.enum(SEARCH_ORIGINS);
export type SearchOrigin = z.infer<typeof searchOriginSchema>;

/** Local usage events (KBC-006 BR-2); the question text never leaves this computer. */
export const usageEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('search'),
    origin: searchOriginSchema,
    question: z.string().min(1).max(2000),
    mode: searchModeSchema,
    filterCount: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    tookMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('filter'),
    filterCount: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('open_doc'),
    /** 1-based place among the results; null when opened from an AI citation or a copy. */
    position: z.number().int().positive().nullable(),
  }),
  z.object({ type: z.literal('ai_answer'), usd: z.number().nonnegative() }),
  z.object({ type: z.literal('ai_cancel') }),
]);
export type UsageEvent = z.infer<typeof usageEventSchema>;

export const usageEventRequestSchema = z.object({
  sessionId: z.uuid(),
  event: usageEventSchema,
});
export type UsageEventRequest = z.infer<typeof usageEventRequestSchema>;

/** One line of events.jsonl: the event plus who and when, added by the API (format version 1). */
export const usageRecordSchema = usageEventSchema.and(
  z.object({
    v: z.literal(1).optional(),
    ts: z.iso.datetime(),
    principal: z.string().min(1),
    sessionId: z.string().min(1),
  }),
);
export type UsageRecord = z.infer<typeof usageRecordSchema>;
