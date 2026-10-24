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

/** Local usage events (KBC-006 BR-2); the question text never leaves this computer. */
export const usageEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('search'),
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

/** One line of events.jsonl: the event plus who and when, added by the API. */
export type UsageRecord = UsageEvent & {
  readonly ts: string;
  readonly principal: string;
  readonly sessionId: string;
};
