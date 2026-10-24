import { z } from 'zod';
import { documentRefSchema } from './search.js';

/** A numbered source: [n] in the answer text points to sources[n - 1]. */
export const answerSourceSchema = documentRefSchema.extend({
  n: z.number().int().positive(),
});
export type AnswerSource = z.infer<typeof answerSourceSchema>;

/** Previous turns sent with a follow-up (KBC-008 BR-4): the text only, never the documents read. */
export const MAX_HISTORY_TURNS = 20;

export const researchTurnSchema = z.object({
  question: z.string().min(1).max(2000),
  answer: z.string().max(20_000),
});
export type ResearchTurn = z.infer<typeof researchTurnSchema>;

/**
 * How hard the agent researches (KBC-011): `fast` uses the provider's fast model and a
 * short step budget with a focused answer; `deep` uses the deep model and the full budget.
 */
export const RESEARCH_PROFILES = ['fast', 'deep'] as const;
export const researchProfileSchema = z.enum(RESEARCH_PROFILES);
export type ResearchProfile = z.infer<typeof researchProfileSchema>;

export const researchRequestSchema = z.strictObject({
  question: z.string().trim().min(1).max(2000),
  history: z.array(researchTurnSchema).max(MAX_HISTORY_TURNS).default([]),
  profile: researchProfileSchema.default('fast'),
});
export type ResearchRequest = z.input<typeof researchRequestSchema>;

/** What the agent is doing, shown as a discreet line while it works (ADR 0006). */
export const researchStepSchema = z.object({
  /** `deepen`: the fast pass was not enough and the deep profile takes over (ADR 0009). */
  kind: z.enum(['search', 'subjects', 'read', 'related', 'deepen']),
  /** Short pt-BR description, e.g. "Buscando “cinco princípios ocultos”". */
  text: z.string(),
});
export type ResearchStep = z.infer<typeof researchStepSchema>;

/** How a research turn was paid: per token (cost shown, daily cap) or by a subscription (KBC-007 BR-2). */
export const researchBillingSchema = z.enum(['per-token', 'subscription']);
export type ResearchBilling = z.infer<typeof researchBillingSchema>;

/** Which model call a piece of answer text came from (KBC-011): one segment per call. */
const segmentSchema = z.number().int().nonnegative();

/**
 * Server-sent events of POST /topics/:topic/research (one JSON object per `data:` line).
 * `start` comes first, with the model and billing of the turn (so a stopped turn is saved
 * with them); `sources` repeats the full list whenever the agent meets new documents; [n] in the text
 * points to the source numbered n. Text streams at once as `token`s of a segment; when the
 * model call that wrote a segment turns out to call tools, `retract` takes that segment back
 * out of the answer (it was the agent thinking aloud, ADR 0009).
 */
export const researchEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    model: z.string(),
    billing: researchBillingSchema,
  }),
  z.object({ type: z.literal('step'), step: researchStepSchema }),
  z.object({
    type: z.literal('sources'),
    sources: z.array(answerSourceSchema),
  }),
  z.object({
    type: z.literal('token'),
    text: z.string(),
    segment: segmentSchema,
  }),
  z.object({ type: z.literal('retract'), segment: segmentSchema }),
  z.object({
    type: z.literal('done'),
    usd: z.number().nonnegative(),
    billing: researchBillingSchema,
    model: z.string(),
    interrupted: z.boolean(),
    steps: z.number().int().nonnegative(),
    /** True when a fast turn escalated to the deep profile; `model` is then the deep one. */
    escalated: z.boolean().optional(),
  }),
  z.object({ type: z.literal('error'), code: z.string() }),
]);
export type ResearchEvent = z.infer<typeof researchEventSchema>;
