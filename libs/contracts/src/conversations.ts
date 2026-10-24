import { z } from 'zod';
import { answerSourceSchema } from './answers.js';
import { searchFiltersSchema, searchModeSchema } from './search.js';

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

/** One turn of a "Pesquisa com IA" conversation: restored as saved, never re-run (it costs). */
export const savedResearchTurnSchema = z.object({
  question: z.string().min(1),
  answer: z.string(),
  sources: z.array(answerSourceSchema),
  steps: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
  model: z.string(),
  interrupted: z.boolean(),
  at: z.iso.datetime(),
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

export const conversationSummarySchema = z.object({
  id: conversationIdSchema,
  kind: z.enum(['search', 'research']),
  topic: z.string(),
  title: z.string(),
  updatedAt: z.iso.datetime(),
  /** Questions in the conversation. */
  count: z.number().int().positive(),
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
  const count =
    conversation.kind === 'search'
      ? conversation.asks.length
      : conversation.turns.length;
  return { id, kind, topic, title, updatedAt, count };
}
