import {
  conversationIdSchema,
  savedSearchAskSchema,
  type SearchConversation,
} from '@kb-chat/contracts';
import { z } from 'zod';

/** Where the history lived before it moved to the local API (KBC-005 BR-1, 50 at most). */
export const LEGACY_HISTORY_KEY = 'kb-chat.history';

const legacyConversationSchema = z.object({
  id: z.string().min(1),
  topic: z.string().min(1),
  asks: z.array(savedSearchAskSchema).min(1),
  updatedAt: z.iso.datetime(),
});
type LegacyConversation = z.infer<typeof legacyConversationSchema>;

const TITLE_MAX = 2000;

function toConversation(legacy: LegacyConversation): SearchConversation {
  const { topic, asks, updatedAt } = legacy;
  const [first] = asks;
  // Ids were already uuids; anything else gets a new one rather than being lost.
  const id = conversationIdSchema.safeParse(legacy.id).success
    ? legacy.id
    : crypto.randomUUID();
  return {
    kind: 'search',
    id,
    topic,
    title: (first?.question ?? topic).slice(0, TITLE_MAX),
    createdAt: updatedAt,
    updatedAt,
    asks,
  };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** The old browser history as search conversations; entries that do not parse are dropped. */
export function parseLegacyHistory(raw: string): SearchConversation[] {
  const value = parseJson(raw);
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    const parsed = legacyConversationSchema.safeParse(item);
    return parsed.success ? [toConversation(parsed.data)] : [];
  });
}

/** The raw old history, or null when there is none or storage is blocked. */
export function readLegacyHistory(storage: Storage | undefined): string | null {
  try {
    return storage?.getItem(LEGACY_HISTORY_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Called only once every old conversation is on the server. */
export function forgetLegacyHistory(storage: Storage | undefined): void {
  try {
    storage?.removeItem(LEGACY_HISTORY_KEY);
  } catch {
    // Blocked storage: the next start tries again, and saving the same ids twice is harmless.
  }
}
