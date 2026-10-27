import { DOCUMENT } from '@angular/common';
import {
  DestroyRef,
  Injectable,
  Injector,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import type {
  Conversation,
  ResearchEvent,
  ResearchProfile,
  ResearchRequest,
} from '@kb-chat/contracts';
import { ResearchApi } from '@core/api/research-api.js';
import { toUiErrorCode } from '@core/api/api-error.js';
import { SpendStore } from '@core/spend/spend-store.js';
import { UsageLog } from '@core/usage/usage-log.js';
import { ChatStore } from '@features/chat/chat-store.js';
import { ViewStore } from '@features/chat/view-store.js';
import { SettingsStore } from '@features/settings/settings-store.js';
import {
  EMPTY,
  catchError,
  filter,
  finalize,
  switchMap,
  take,
  timer,
  type Observable,
  type Subscription,
} from 'rxjs';
import {
  LOAD_CONVERSATION,
  SAVE_RESEARCH,
  type ResearchConversation,
} from './research-history.js';
import {
  applyEvent,
  fromSavedTurn,
  replayFrom,
  startTurn,
  toHistory,
  toSavedTurn,
  type ResearchTurn,
} from './research-turn.js';

/** The server records a stopped answer's cost a moment after the request is aborted. */
export const STOP_SETTLE_MS = 1000;

/**
 * The research conversation on screen in this tab (KBC-029): a reload brings it back and
 * follows its turn if it is still running.
 */
export const OPEN_RESEARCH_KEY = 'kb-chat.open-research';

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

/** A turn the server no longer runs and still has as pending: it was cut short. */
const cutShort = (turn: ResearchTurn): ResearchTurn =>
  turn.phase === 'streaming'
    ? { ...turn, phase: 'done', interrupted: true }
    : turn;

/** sessionStorage access itself can throw (blocked site data). */
function safeSession(view: Window | null): Storage | undefined {
  try {
    return view?.sessionStorage;
  } catch {
    return undefined;
  }
}

/** Where a turn's events come from: the request that asked it, or following it again. */
interface TurnRun {
  readonly id: number;
  readonly events: Observable<ResearchEvent>;
  /** Asked by this page (else followed again after a reload or a dropped stream). */
  readonly asked: boolean;
}

/**
 * The "Pesquisa com IA" conversation (KBC-008, provided on the chat page, NG-16): one turn in
 * flight at a time, follow-ups carry the previous answers (BR-4), stop, restore and history.
 * Since KBC-029 every question is in the history as soon as it is sent, and the server runs
 * the turn to its end even if this page goes away.
 */
@Injectable()
export class ResearchStore {
  private readonly api = inject(ResearchApi);
  private readonly chat = inject(ChatStore);
  private readonly views = inject(ViewStore);
  private readonly spend = inject(SpendStore);
  private readonly usage = inject(UsageLog);
  private readonly settings = inject(SettingsStore);
  private readonly saveConversation = inject(SAVE_RESEARCH);
  private readonly injector = inject(Injector);
  private readonly session = safeSession(inject(DOCUMENT).defaultView);
  private readonly destroyRef = inject(DestroyRef);
  private subscription: Subscription | null = null;
  /** Leaving the page completes the streams: nothing to follow or record then. */
  private destroyed = false;
  private nextId = 1;
  /** Today's spend when the turn in flight started: a stop prices the turn by the difference. */
  private spendAtStart: number | null = null;
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
  /** "Rápido | Profundo" of the next question (KBC-011), remembered in this browser. */
  readonly profile = this.settings.researchProfile;

  constructor() {
    this.destroyRef.onDestroy(() => (this.destroyed = true));
    this.reopenAfterReload();
  }

  chooseProfile(profile: ResearchProfile): void {
    this.settings.chooseResearchProfile(profile);
  }

  /**
   * Asks the agent; a turn still in flight in this conversation is stopped first (one at a
   * time). The conversation goes to the history at once, the question as a pending turn.
   */
  ask(question: string, turnId?: string): void {
    const topic = this.chat.topicSlug();
    const trimmed = question.trim();
    if (!topic || !trimmed) return;
    if (this.streaming()) this.stop();
    if (this.state().topic !== topic) this.state.set(emptyConversation(topic));
    const history = toHistory(this.state().turns);
    const profile = this.profile();
    const turn = startTurn(this.nextId++, trimmed, { profile, turnId });
    this.state.update((s) => ({ ...s, turns: [...s.turns, turn] }));
    this.persist();
    this.remember(this.state().id);
    const request: ResearchRequest = {
      question: trimmed,
      history,
      profile,
      conversationId: this.state().id,
      turnId: turn.turnId,
    };
    this.run({
      id: turn.id,
      events: this.api.research(topic, request),
      asked: true,
    });
  }

  /** "Tentar de novo" on the last turn (failed or stopped): asks the same question in its place. */
  retry(): void {
    const last = this.state().turns.at(-1);
    const retriable =
      last?.phase === 'error' || (last?.phase === 'done' && last.interrupted);
    if (!last || !retriable) return;
    this.state.update((s) => ({ ...s, turns: s.turns.slice(0, -1) }));
    this.ask(last.question, last.turnId);
  }

  /**
   * "Parar": the server stops the agent, records the partial cost and saves the turn as
   * interrupted. The page shows and saves it at once (also with no text yet), and again with
   * that cost once known.
   */
  stop(): void {
    const current = this.state().turns.find((t) => t.phase === 'streaming');
    if (!current) return;
    this.usage.track({ type: 'ai_cancel' });
    this.detach();
    // A stop that does not arrive leaves the turn to end by itself; it is still saved.
    this.api.stopTurn(current.turnId).subscribe({ error: () => undefined });
    this.patch(current.id, (turn) => ({
      ...turn,
      phase: 'done',
      interrupted: true,
    }));
    this.persist();
    this.settleStoppedCost(current.id);
  }

  /**
   * "+ Nova conversa" in this view: an empty conversation in the same collection (BR-4). A
   * turn still running goes on and lands in the history (KBC-029).
   */
  newConversation(): void {
    this.detach();
    this.forget();
    this.state.set(emptyConversation(this.chat.topicSlug()));
  }

  /**
   * Shows a saved conversation as it was, without calling the AI (FR-6, AC-9); a turn still
   * running on the server is followed to its end (KBC-029).
   */
  restore(conversation: ResearchConversation): void {
    this.detach();
    this.chat.selectTopic(conversation.topic);
    this.views.select('research');
    this.remember(conversation.id);
    const turns = conversation.turns.map((t) =>
      fromSavedTurn(this.nextId++, t),
    );
    this.state.set({
      id: conversation.id,
      topic: conversation.topic,
      createdAt: conversation.createdAt,
      turns,
    });
    const running = turns.find((turn) => turn.phase === 'streaming');
    if (running) this.followAgain(running);
  }

  /** Saves the conversation on screen, every turn with its phase (the history seam, SAVE_RESEARCH). */
  persist(): void {
    const conversation = this.toConversation();
    if (conversation) this.saveConversation(conversation);
  }

  private toConversation(): ResearchConversation | null {
    const { id, topic, createdAt, turns } = this.state();
    const first = turns[0];
    if (!topic || !first) return null;
    return {
      kind: 'research',
      id,
      topic,
      title: first.question,
      createdAt,
      updatedAt: new Date().toISOString(),
      turns: turns.map(toSavedTurn),
    };
  }

  private run({ id, events, asked }: TurnRun): void {
    let started = false;
    this.spendAtStart = this.spend.usd();
    this.subscription = events
      .pipe(
        // Today's spend follows every turn, also one cut short by "Parar" (KBC-005 FR-5).
        finalize(() => this.refreshSpend(id)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (event) => {
          started ||= event.type === 'start';
          this.apply(id, event);
        },
        error: (err: unknown) => this.ended(id, { asked, started, err }),
        complete: () => this.ended(id, { asked, started, err: null }),
      });
  }

  /**
   * A stream that ended before the turn did. Refused before the server took it: the page
   * records the failure. Cut off after (a dropped connection): the server may still run it,
   * so the page follows it again. A follow that ends so: the history has the outcome.
   */
  private ended(
    id: number,
    how: { asked: boolean; started: boolean; err: unknown },
  ): void {
    const turn = this.state().turns.find((t) => t.id === id);
    if (this.destroyed || turn?.phase !== 'streaming') return;
    if (!how.asked) this.adoptSaved(turn);
    else if (how.started) this.followAgain(turn);
    else if (how.err !== null) this.refused(id, how.err);
    else this.unfinished(id);
  }

  /** Refused before the server took it: the page records the failure. */
  private refused(id: number, err: unknown): void {
    this.patch(id, (turn) => ({
      ...turn,
      phase: 'error',
      error: toUiErrorCode(err),
    }));
    this.persist();
  }

  private unfinished(id: number): void {
    this.patch(id, endUnfinished);
    this.persist();
  }

  private followAgain(turn: ResearchTurn): void {
    this.patch(turn.id, replayFrom);
    const events = this.api.follow(turn.turnId);
    this.run({ id: turn.id, events, asked: false });
  }

  /** The turn is not running any more: shows what the history kept of it. */
  private adoptSaved(turn: ResearchTurn): void {
    const conversationId = this.state().id;
    this.load(conversationId).subscribe({
      next: (saved) => {
        if (this.state().id !== conversationId) return;
        const kept =
          saved.kind === 'research'
            ? saved.turns.find((t) => t.id === turn.turnId)
            : undefined;
        const shown = kept ? fromSavedTurn(turn.id, kept) : turn;
        this.patch(turn.id, () => cutShort(shown));
      },
      error: () => this.patch(turn.id, cutShort),
    });
  }

  private load(id: string): Observable<Conversation> {
    return this.injector.get(LOAD_CONVERSATION)(id);
  }

  private apply(id: number, event: ResearchEvent): void {
    if (event.type === 'done' && !event.interrupted)
      this.usage.track({ type: 'ai_answer', usd: event.usd });
    this.patch(id, (turn) => applyEvent(turn, event));
    if (event.type === 'done' || event.type === 'error') this.persist();
    // "Pesquisas restantes hoje" in Settings follows each answer (KBC-022).
    if (event.type === 'done') this.settings.aiStatus.reload();
  }

  /** Stops showing the turn in flight; the server keeps running it (KBC-029). */
  private detach(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
  }

  /** Reads today's spend after the server recorded the stopped turn; the rise is its cost. */
  private settleStoppedCost(id: number): void {
    const before = this.spendAtStart;
    const turn = this.state().turns.find((t) => t.id === id);
    if (before === null || turn?.billing !== 'per-token') return;
    const conversationId = this.state().id;
    timer(STOP_SETTLE_MS)
      .pipe(
        switchMap(() => this.api.spendToday()),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (today) => {
          if (this.state().id !== conversationId) return;
          const usd = Math.max(0, today.usd - before);
          this.patch(id, (t) => ({ ...t, usd }));
          this.persist();
        },
        // The cost stays unknown (0) in the saved turn; the side panel still refreshes.
        error: () => undefined,
      });
  }

  private refreshSpend(id: number): void {
    const turn = this.state().turns.find((t) => t.id === id);
    const short = !turn || turn.phase === 'streaming' || turn.interrupted;
    this.spend.refresh(short ? STOP_SETTLE_MS : 0);
  }

  /**
   * After a reload in the research view, brings back the conversation that was on screen
   * once the collections are known (restoring before would lose its collection).
   */
  private reopenAfterReload(): void {
    const id = this.readOpen();
    if (!id || this.views.current() !== 'research') return;
    toObservable(this.chat.topicSlug)
      .pipe(
        filter((slug) => slug !== null),
        take(1),
        switchMap(() => this.load(id)),
        catchError(() => EMPTY),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((conversation) => {
        if (conversation.kind === 'research' && this.state().turns.length === 0)
          this.restore(conversation);
      });
  }

  private readOpen(): string | null {
    try {
      return this.session?.getItem(OPEN_RESEARCH_KEY) ?? null;
    } catch {
      return null;
    }
  }

  private remember(id: string): void {
    try {
      this.session?.setItem(OPEN_RESEARCH_KEY, id);
    } catch {
      // Blocked storage: a reload just starts a new conversation, as before.
    }
  }

  private forget(): void {
    try {
      this.session?.removeItem(OPEN_RESEARCH_KEY);
    } catch {
      // Same as above.
    }
  }

  private patch(id: number, change: (turn: ResearchTurn) => ResearchTurn) {
    this.state.update((s) => ({
      ...s,
      turns: s.turns.map((turn) => (turn.id === id ? change(turn) : turn)),
    }));
  }
}
