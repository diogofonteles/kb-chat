import { computed, signal, type WritableSignal } from '@angular/core';
import { conversationSchema, type Conversation } from '@kb-chat/contracts';
import { z } from 'zod';

/** Conversations whose save did not reach the API yet, kept in this browser meanwhile. */
export const PENDING_SAVES_KEY = 'kb-chat.pending-saves';

const pendingSchema = z.array(z.unknown());

function readItems(storage: Storage | undefined): readonly unknown[] {
  try {
    const raw = storage?.getItem(PENDING_SAVES_KEY);
    const items = pendingSchema.safeParse(JSON.parse(raw ?? '[]'));
    return items.success ? items.data : [];
  } catch {
    // Unreadable or blocked storage: nothing pending from an earlier visit.
    return [];
  }
}

function readPending(storage: Storage | undefined): Map<string, Conversation> {
  const pending = new Map<string, Conversation>();
  for (const item of readItems(storage)) {
    const conversation = conversationSchema.safeParse(item);
    if (conversation.success)
      pending.set(conversation.data.id, conversation.data);
  }
  return pending;
}

/**
 * The latest snapshot of each conversation whose PUT failed, by id (KBC-005 BR-1: the
 * history never loses a conversation silently). Mirrored to localStorage, so a reload
 * before the API is back keeps them and sends them again.
 */
export class PendingSaves {
  private readonly state: WritableSignal<ReadonlyMap<string, Conversation>>;
  readonly items = computed(() => [...this.state().values()]);
  readonly size = computed(() => this.state().size);

  constructor(private readonly storage: Storage | undefined) {
    this.state = signal<ReadonlyMap<string, Conversation>>(
      readPending(storage),
    );
  }

  get(id: string): Conversation | undefined {
    return this.state().get(id);
  }

  add(conversation: Conversation): void {
    this.write(new Map(this.state()).set(conversation.id, conversation));
  }

  remove(id: string): void {
    if (!this.state().has(id)) return;
    const next = new Map(this.state());
    next.delete(id);
    this.write(next);
  }

  private write(next: ReadonlyMap<string, Conversation>): void {
    this.state.set(next);
    try {
      if (next.size === 0) this.storage?.removeItem(PENDING_SAVES_KEY);
      else
        this.storage?.setItem(
          PENDING_SAVES_KEY,
          JSON.stringify([...next.values()]),
        );
    } catch {
      // Full or blocked storage: the snapshot stays in memory for this visit.
    }
  }
}
