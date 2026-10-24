import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { ResearchEvent, ResearchRequest } from '@kb-chat/contracts';
import { AnswersApi } from '@core/api/answers-api.js';
import { toUiErrorCode } from '@core/api/api-error.js';
import { SpendStore } from '@core/spend/spend-store.js';
import { UsageLog } from '@core/usage/usage-log.js';
import { ChatStore } from '@features/chat/chat-store.js';
import { ViewStore } from '@features/chat/view-store.js';
import { finalize, type Subscription } from 'rxjs';
import {
  SAVE_RESEARCH,
  type ResearchConversation,
} from './research-history.js';
import {
  applyEvent,
  fromSavedTurn,
  isFinished,
  startTurn,
  toHistory,
  toSavedTurn,
  type ResearchTurn,
} from './research-turn.js';

/** The server records a stopped answer's cost a moment after the request is aborted. */
export const STOP_SETTLE_MS = 1000;

interface ConversationState {
  readonly id: string;
  readonly topic: string | null;
  readonly createdAt: string;
  readonly turns: readonly ResearchTurn[];
}

const emptyConversation = (topic: string | null): ConversationState => ({
  id: crypto.randomUUID(),
  topic,
  createdAt: new Date().toISOString(),
  turns: [],
});

/** A stream that closed without "done" ends the turn: as interrupted with text, as failed without. */
const endUnfinished = (turn: ResearchTurn): ResearchTurn =>
  turn.phase !== 'streaming'
    ? turn
    : turn.text.trim()
      ? { ...turn, phase: 'done', interrupted: true }
      : { ...turn, phase: 'error', error: 'INTERNAL' };

/**
 * The "Pesquisa com IA" conversation (KBC-008, provided on the chat page, NG-16): one turn in
 * flight at a time, follow-ups carry the previous answers (BR-4), stop, restore and history.
 */
@Injectable()
export class ResearchStore {
  private readonly api = inject(AnswersApi);
  private readonly chat = inject(ChatStore);
  private readonly views = inject(ViewStore);
  private readonly spend = inject(SpendStore);
  private readonly usage = inject(UsageLog);
  private readonly saveConversation = inject(SAVE_RESEARCH);
  private readonly destroyRef = inject(DestroyRef);
  private subscription: Subscription | null = null;
  private nextId = 1;
  private readonly state = signal<ConversationState>(emptyConversation(null));

  readonly conversationId = computed(() => this.state().id);
  /** A conversation belongs to its collection: another collection shows an empty one (KBC-005 BR-2). */
  readonly turns = computed(() => {
    const { topic, turns } = this.state();
    return topic === null || topic === this.chat.topicSlug() ? turns : [];
  });
  readonly streaming = computed(() =>
    this.turns().some((turn) => turn.phase === 'streaming'),
  );

  /** Asks the agent; a turn still in flight is stopped first (one at a time). */
  ask(question: string): void {
    const topic = this.chat.topicSlug();
    const trimmed = question.trim();
    if (!topic || !trimmed) return;
    if (this.streaming()) this.stop();
    if (this.state().topic !== topic) this.state.set(emptyConversation(topic));
    const history = toHistory(this.state().turns);
    const turn = startTurn(this.nextId++, trimmed);
    this.state.update((s) => ({ ...s, turns: [...s.turns, turn] }));
    this.run(turn.id, topic, { question: trimmed, history });
  }

  /** "Tentar de novo" on the last turn: asks the same question in its place. */
  retry(): void {
    const last = this.state().turns.at(-1);
    if (!last || last.phase !== 'error') return;
    this.state.update((s) => ({ ...s, turns: s.turns.slice(0, -1) }));
    this.ask(last.question);
  }

  /** "Parar": aborts the request; the server stops the agent and records the partial cost. */
  stop(): void {
    const current = this.state().turns.find((t) => t.phase === 'streaming');
    if (!current) return;
    this.usage.track({ type: 'ai_cancel' });
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.patch(current.id, (turn) => ({
      ...turn,
      phase: 'done',
      interrupted: true,
    }));
    this.persist();
  }

  /** "+ Nova conversa" in this view: an empty conversation in the same collection (BR-4). */
  newConversation(): void {
    this.stop();
    this.state.set(emptyConversation(this.chat.topicSlug()));
  }

  /** Shows a saved conversation as it was, without calling the AI (FR-6, AC-9). */
  restore(conversation: ResearchConversation): void {
    this.stop();
    this.chat.selectTopic(conversation.topic);
    this.views.select('research');
    this.state.set({
      id: conversation.id,
      topic: conversation.topic,
      createdAt: conversation.createdAt,
      turns: conversation.turns.map((t) => fromSavedTurn(this.nextId++, t)),
    });
  }

  /** Saves the finished turns of the conversation on screen (the history seam, SAVE_RESEARCH). */
  persist(): void {
    const conversation = this.toConversation();
    if (conversation) this.saveConversation(conversation);
  }

  private toConversation(): ResearchConversation | null {
    const { id, topic, createdAt, turns } = this.state();
    const finished = turns.filter(isFinished);
    const first = finished[0];
    if (!topic || !first) return null;
    return {
      kind: 'research',
      id,
      topic,
      title: first.question,
      createdAt,
      updatedAt: new Date().toISOString(),
      turns: finished.map(toSavedTurn),
    };
  }

  private run(id: number, topic: string, request: ResearchRequest): void {
    this.subscription = this.api
      .research(topic, request)
      .pipe(
        // Today's spend follows every turn, also one cut short by "Parar" (KBC-005 FR-5).
        finalize(() => this.refreshSpend(id)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (event) => this.apply(id, event),
        error: (err: unknown) =>
          this.patch(id, (turn) => ({
            ...turn,
            phase: 'error',
            error: toUiErrorCode(err),
          })),
        complete: () => this.patch(id, endUnfinished),
      });
  }

  private apply(id: number, event: ResearchEvent): void {
    if (event.type === 'done' && !event.interrupted)
      this.usage.track({ type: 'ai_answer', usd: event.usd });
    this.patch(id, (turn) => applyEvent(turn, event));
    if (event.type === 'done') this.persist();
  }

  private refreshSpend(id: number): void {
    const turn = this.state().turns.find((t) => t.id === id);
    const cutShort = !turn || turn.phase === 'streaming' || turn.interrupted;
    this.spend.refresh(cutShort ? STOP_SETTLE_MS : 0);
  }

  private patch(id: number, change: (turn: ResearchTurn) => ResearchTurn) {
    this.state.update((s) => ({
      ...s,
      turns: s.turns.map((turn) => (turn.id === id ? change(turn) : turn)),
    }));
  }
}
