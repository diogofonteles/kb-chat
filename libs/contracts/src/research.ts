import { z } from 'zod';
import { answerSourceSchema } from './answers.js';

/** Previous turns sent with a follow-up (KBC-008 BR-4): the text only, never the documents read. */
export const MAX_HISTORY_TURNS = 20;

export const researchTurnSchema = z.object({
  question: z.string().min(1).max(2000),
  answer: z.string().max(20_000),
});
export type ResearchTurn = z.infer<typeof researchTurnSchema>;

export const researchRequestSchema = z.strictObject({
  question: z.string().trim().min(1).max(2000),
  history: z.array(researchTurnSchema).max(MAX_HISTORY_TURNS).default([]),
});
export type ResearchRequest = z.input<typeof researchRequestSchema>;

/** What the agent is doing, shown as a discreet line while it works (ADR 0006). */
export const researchStepSchema = z.object({
  kind: z.enum(['search', 'subjects', 'read', 'related']),
  /** Short pt-BR description, e.g. "Buscando “cinco princípios ocultos”". */
  text: z.string(),
});
export type ResearchStep = z.infer<typeof researchStepSchema>;

/** How a research turn was paid: per token (cost shown, daily cap) or by a subscription (KBC-007 BR-2). */
export const researchBillingSchema = z.enum(['per-token', 'subscription']);
export type ResearchBilling = z.infer<typeof researchBillingSchema>;

/**
 * Server-sent events of POST /topics/:topic/research (one JSON object per `data:` line).
 * `sources` repeats the full list whenever the agent meets new documents; [n] in the text
 * points to the source numbered n.
 */
export const researchEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('step'), step: researchStepSchema }),
  z.object({
    type: z.literal('sources'),
    sources: z.array(answerSourceSchema),
  }),
  z.object({ type: z.literal('token'), text: z.string() }),
  z.object({
    type: z.literal('done'),
    usd: z.number().nonnegative(),
    billing: researchBillingSchema,
    model: z.string(),
    interrupted: z.boolean(),
    steps: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('error'), code: z.string() }),
]);
export type ResearchEvent = z.infer<typeof researchEventSchema>;
