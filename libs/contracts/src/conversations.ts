import { z } from 'zod';
import {
  answerSourceSchema,
  researchBillingSchema,
  researchPlanSchema,
  researchProfileSchema,
} from './research.js';
import { searchFiltersSchema, searchModeSchema } from './search.js';
import { sweepCoverageSchema, sweepCursorSchema } from './sweep.js';

/**
 * Conversations kept by the local API, all of them, without a cap (owner, 2026-10-24:
 * "precisamos manter 100% do histórico das conversas"). Stored in ~/.kb-chat/conversations/.
 */
export const conversationIdSchema = z.uuid();

/** One question of a "Buscar documentos" conversation: re-run on restore (search is free). */
export const savedSearchAskSchema = z.object({
  question: z.string().min(1),
  mode: searchModeSchema,
  filters: searchFiltersSchema,
  /** Result count when the search finished, or null. */
  total: z.number().int().nonnegative().nullable(),
});
export type SavedSearchAsk = z.infer<typeof savedSearchAskSchema>;

export const savedTurnStatusSchema = z.enum(['pending', 'failed']);

/**
 * A stored source the reader may no longer see (KBC-110, ADR 0036 §8): only its number, so
 * "[n]" in the kept prose still points somewhere; no id, title, authorship or passage.
 */
export const restrictedSourceSchema = z.strictObject({
  n: z.number().int().positive(),
  restricted: z.literal(true),
});
export type RestrictedSource = z.infer<typeof restrictedSourceSchema>;

/** A source of a saved answer: as the answer cited it, or restricted for today's reader. */
export const savedAnswerSourceSchema = z.union([
  answerSourceSchema,
  restrictedSourceSchema,
]);
export type SavedAnswerSource = z.infer<typeof savedAnswerSourceSchema>;

export const isRestrictedSource = (
  source: SavedAnswerSource,
): source is RestrictedSource => 'restricted' in source;

/** One turn of a "Pesquisa com IA" conversation: restored as saved, never re-run (it costs). */
export const savedResearchTurnSchema = z.object({
  question: z.string().min(1),
  answer: z.string(),
  sources: z.array(savedAnswerSourceSchema),
  /** KBC-110: how many of `sources` today's reader may not see; absent when none. */
  restrictedSources: z.number().int().positive().optional(),
  steps: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
  /** Turns saved before KBC-007 were all per token. */
  billing: researchBillingSchema.default('per-token'),
  model: z.string(),
  interrupted: z.boolean(),
  /** The fast turn went on with the deep profile (ADR 0009); absent in older turns. */
  escalated: z.boolean().optional(),
  /** The research profile the turn ran with (KBC-017); absent in older turns. */
  profile: researchProfileSchema.optional(),
  /** Who paid (KBC-022); absent in older turns. */
  plan: researchPlanSchema.optional(),
  /** Exhaustive sweep (KBC-030): the coverage the app measured; absent in older turns. */
  coverage: sweepCoverageSchema.optional(),
  /** An unfinished sweep's cursor, for "Continuar varredura". */
  sweep: sweepCursorSchema.optional(),
  at: z.iso.datetime(),
  /** KBC-029: the turn's id (kept by "Tentar de novo"); absent in older turns. */
  id: z.uuid().optional(),
  /**
   * KBC-029: `pending` while the agent works, `failed` when it could not answer; absent once
   * it finished (`interrupted` tells a stopped one).
   */
  status: savedTurnStatusSchema.optional(),
  /** The error code of a failed turn. */
  error: z.string().min(1).max(64).optional(),
});
export type SavedResearchTurn = z.infer<typeof savedResearchTurnSchema>;

const base = {
  id: conversationIdSchema,
  topic: z.string().min(1),
  /** The first question, as typed. */
  title: z.string().min(1).max(2000),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

export const conversationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('search'),
    ...base,
    asks: z.array(savedSearchAskSchema).min(1),
  }),
  z.object({
    kind: z.literal('research'),
    ...base,
    turns: z.array(savedResearchTurnSchema).min(1),
  }),
]);
export type Conversation = z.infer<typeof conversationSchema>;
export type ConversationKind = Conversation['kind'];

/** What the history shows next to a conversation (KBC-029): working, stopped or failed. */
export const conversationStatusSchema = z.enum([
  'pending',
  'interrupted',
  'failed',
]);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

/** The status of a research turn as the history shows it; undefined for an answered one. */
export function turnStatusOf(
  turn: SavedResearchTurn,
): ConversationStatus | undefined {
  if (turn.status) return turn.status;
  return turn.interrupted ? 'interrupted' : undefined;
}

export const conversationSummarySchema = z.object({
  id: conversationIdSchema,
  kind: z.enum(['search', 'research']),
  topic: z.string(),
  title: z.string(),
  updatedAt: z.iso.datetime(),
  /** Questions in the conversation. */
  count: z.number().int().positive(),
  /** KBC-029: how the latest research turn stands; absent when it answered. */
  status: conversationStatusSchema.optional(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

/** GET /api/v1/conversations — every conversation, newest first. */
export const conversationListSchema = z.object({
  items: z.array(conversationSummarySchema),
});
export type ConversationList = z.infer<typeof conversationListSchema>;

export type SearchConversation = Extract<Conversation, { kind: 'search' }>;
export type ResearchConversation = Extract<Conversation, { kind: 'research' }>;

/** The list entry of a conversation; shared so the web can update its list before the API answers. */
export function summarizeConversation(
  conversation: Conversation,
): ConversationSummary {
  const { id, kind, topic, title, updatedAt } = conversation;
  if (conversation.kind === 'search')
    return {
      id,
      kind,
      topic,
      title,
      updatedAt,
      count: conversation.asks.length,
    };
  const { turns } = conversation;
  const last = turns.at(-1);
  const status = last ? turnStatusOf(last) : undefined;
  const summary = { id, kind, topic, title, updatedAt, count: turns.length };
  return status ? { ...summary, status } : summary;
}
