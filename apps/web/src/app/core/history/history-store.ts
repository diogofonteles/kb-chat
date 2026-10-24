import { DOCUMENT } from '@angular/common';
import { Injectable, inject, signal } from '@angular/core';
import { searchFiltersSchema, searchModeSchema } from '@kb-chat/contracts';
import { z } from 'zod';

/** Conversations kept in this browser (KBC-005 BR-1). */
export const MAX_CONVERSATIONS = 50;
const STORAGE_KEY = 'kb-chat.history';

const savedAskSchema = z.object({
  question: z.string().min(1),
  mode: searchModeSchema,
  filters: searchFiltersSchema,
  /** Result count when the search finished, or null (summary only, never document bodies). */
  total: z.number().int().nonnegative().nullable(),
});
export type SavedAsk = z.infer<typeof savedAskSchema>;

const conversationSchema = z.object({
  id: z.string().min(1),
  topic: z.string().min(1),
  asks: z.array(savedAskSchema).min(1),
  updatedAt: z.string(),
});
export type Conversation = z.infer<typeof conversationSchema>;

const historySchema = z.array(conversationSchema);

/** Unreadable data (an older version, a manual edit) starts an empty history, replaced on the next save. */
function parseHistory(raw: string): Conversation[] {
  try {
    const parsed = historySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.slice(0, MAX_CONVERSATIONS) : [];
  } catch {
    return [];
  }
}

/** Newest first; saving an existing id moves it to the top; the oldest beyond the cap are dropped. */
export function upsertConversation(
  history: readonly Conversation[],
  conversation: Conversation,
): Conversation[] {
  return [
    conversation,
    ...history.filter((item) => item.id !== conversation.id),
  ].slice(0, MAX_CONVERSATIONS);
}

/** Session history in localStorage; when storage fails the app keeps working without it. */
@Injectable({ providedIn: 'root' })
export class HistoryStore {
  private readonly view = inject(DOCUMENT).defaultView;
  private readonly availableState = signal(true);
  readonly available = this.availableState.asReadonly();
  private readonly state = signal<readonly Conversation[]>(this.read());
  readonly conversations = this.state.asReadonly();

  save(conversation: Conversation): void {
    const next = upsertConversation(this.state(), conversation);
    this.state.set(next);
    this.write(next);
  }

  find(id: string): Conversation | undefined {
    return this.state().find((item) => item.id === id);
  }

  private read(): Conversation[] {
    let raw: string | null | undefined;
    try {
      raw = this.view?.localStorage.getItem(STORAGE_KEY);
    } catch {
      this.availableState.set(false);
      return [];
    }
    return raw ? parseHistory(raw) : [];
  }

  private write(history: readonly Conversation[]): void {
    if (!this.availableState()) return;
    try {
      this.view?.localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch {
      this.availableState.set(false);
    }
  }
}
