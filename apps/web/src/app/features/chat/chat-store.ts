import { DOCUMENT } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  Injectable,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  topicListSchema,
  type DocumentRef,
  type SearchConversation,
  type SearchFilters,
  type SearchMode,
  type SearchResponse,
  type TopicList,
} from '@kb-chat/contracts';
import { toUiErrorCode } from '@core/api/api-error.js';
import { HistoryStore } from '@core/history/history-store.js';
import { UsageLog } from '@core/usage/usage-log.js';
import { KbApi, topicsUrl } from '@core/api/kb-api.js';
import {
  Subject,
  catchError,
  groupBy,
  map,
  merge,
  mergeMap,
  of,
  scan,
  startWith,
  switchMap,
  tap,
  timer,
  type Observable,
} from 'rxjs';
import {
  NO_FILTERS,
  reduceChat,
  type Ask,
  type ChatEvent,
  type ChatMessage,
} from './chat-message.js';
import { readModePreference, writeModePreference } from './mode-preference.js';

/** Chip clicks within this window become one search (QA-7). */
const REFINE_DEBOUNCE_MS = 250;

export interface OpenDocument {
  readonly topic: string;
  readonly id: string;
  readonly title: string;
  /** The message whose result opened the panel (filters by subject apply to it). */
  readonly messageId: number | null;
  /** Its question, highlighted in the text. */
  readonly question: string | null;
}

/** localStorage access itself can throw (blocked site data); the app then runs without it. */
function safeStorage(view: Window | null): Storage | undefined {
  try {
    return view?.localStorage;
  } catch {
    return undefined;
  }
}

/** KB_TOPIC when configured, otherwise the largest collection (the main study material). */
function pickDefaultTopic(list: TopicList | null): string | null {
  if (!list) return null;
  if (list.defaultSlug) return list.defaultSlug;
  return (
    [...list.items].sort((a, b) => b.documentCount - a.documentCount)[0]
      ?.slug ?? null
  );
}

export interface AskOptions {
  readonly mode?: SearchMode;
  readonly filters?: SearchFilters;
  readonly origin?: Ask['origin'];
}

const newConversationId = (): string => crypto.randomUUID();

const countFilters = (filters: SearchFilters): number =>
  Object.values(filters).reduce((sum, values) => sum + values.length, 0);

/** The contract's limit for a title (the first question, as typed). */
const TITLE_MAX = 2000;

/** Which conversation is on screen and since when (kept across saves of the same one). */
interface ConversationMeta {
  readonly id: string;
  /** Set when its first question is saved; a restored one keeps its own. */
  readonly createdAt: string | null;
}

const freshConversation = (): ConversationMeta => ({
  id: newConversationId(),
  createdAt: null,
});

/**
 * The history entry for the messages on screen, from the first question on (KBC-029: it is in
 * the history as soon as it is sent; its result count comes when the search answers).
 */
function toConversation(
  meta: ConversationMeta,
  messages: readonly ChatMessage[],
): SearchConversation | null {
  const first = messages[0];
  if (!first) return null;
  const now = new Date().toISOString();
  return {
    kind: 'search',
    id: meta.id,
    topic: first.topic,
    title: first.question.slice(0, TITLE_MAX),
    createdAt: meta.createdAt ?? now,
    updatedAt: now,
    asks: messages.map(({ question, mode, filters, response }) => ({
      question,
      mode,
      filters,
      total: response?.total ?? null,
    })),
  };
}

/** Conversation state of the chat page (provided on the page, NG-16). */
@Injectable()
export class ChatStore {
  private readonly api = inject(KbApi);
  private readonly storage = safeStorage(inject(DOCUMENT).defaultView);
  private readonly history = inject(HistoryStore);
  private readonly usage = inject(UsageLog);
  private readonly asks = new Subject<Ask>();
  private readonly mores = new Subject<ChatMessage>();
  private readonly resets = new Subject<ChatEvent>();
  private nextId = 1;
  private nextRev = 1;
  private rememberedKey = '';

  readonly topics = httpResource(topicsUrl, {
    parse: (body) => topicListSchema.parse(body),
  });
  // A resource in error throws on value(); hasValue() guards every read.
  private readonly topicData = computed(() =>
    this.topics.hasValue() ? this.topics.value() : null,
  );
  readonly topicList = computed(() => this.topicData()?.items ?? []);
  readonly topicSlug = linkedSignal(() => pickDefaultTopic(this.topicData()));
  readonly topic = computed(
    () => this.topicList().find((t) => t.slug === this.topicSlug()) ?? null,
  );

  private readonly modeState = signal<SearchMode>(
    readModePreference(this.storage),
  );
  readonly mode = this.modeState.asReadonly();

  readonly messages = toSignal(
    merge(
      this.resets,
      // Per message, a new run (retry, new filters) cancels the one in flight.
      this.asks.pipe(
        groupBy((ask) => ask.id),
        mergeMap((runs) => runs.pipe(switchMap((ask) => this.run(ask)))),
      ),
      this.mores.pipe(mergeMap((message) => this.runMore(message))),
    ).pipe(
      scan(reduceChat, [] as readonly ChatMessage[]),
      tap((messages) => this.remember(messages)),
    ),
    { initialValue: [] as readonly ChatMessage[] },
  );

  /** A search of the conversation on screen is running ("pesquisando…" in the history, KBC-029). */
  readonly searching = computed(() =>
    this.messages().some((message) => message.status === 'loading'),
  );

  /** Id of the conversation on screen in the history (KBC-005 BR-1). */
  private readonly conversationState = signal(freshConversation());
  readonly conversationId = computed(() => this.conversationState().id);
  /** Collection just switched to, shown inline until the next question (BR-2). */
  private readonly topicNoticeState = signal<string | null>(null);
  readonly topicNotice = this.topicNoticeState.asReadonly();

  private readonly openState = signal<OpenDocument | null>(null);
  readonly openDocument = this.openState.asReadonly();
  /** Documents left through "Veja também", for "← Voltar" inside the panel. */
  private readonly historyState = signal<readonly OpenDocument[]>([]);
  readonly canGoBack = computed(() => this.historyState().length > 0);

  constructor() {
    effect(() => writeModePreference(this.storage, this.modeState()));
  }

  /** Writes the conversation to the history when its summary changed (not on every page or chip). */
  private remember(messages: readonly ChatMessage[]): void {
    const meta = this.conversationState();
    const conversation = toConversation(meta, messages);
    if (!conversation) return;
    if (meta.createdAt === null)
      this.conversationState.set({
        ...meta,
        createdAt: conversation.createdAt,
      });
    const key = JSON.stringify([
      conversation.id,
      conversation.topic,
      conversation.asks,
    ]);
    if (key === this.rememberedKey) return;
    this.rememberedKey = key;
    this.history.save(conversation);
  }

  /** "+ Nova conversa" (FR-1): an empty conversation in the same collection. */
  newConversation(): void {
    this.topicNoticeState.set(null);
    this.reset();
  }

  /** Another collection starts a new conversation, with an inline notice (FR-3, BR-2). */
  selectTopic(slug: string): void {
    if (slug === this.topicSlug()) return;
    this.topicSlug.set(slug);
    this.reset();
    this.topicNoticeState.set(slug);
  }

  /** Brings a search conversation back from the history and runs its searches again (FR-2). */
  restore(conversation: SearchConversation): void {
    this.topicSlug.set(conversation.topic);
    this.reset();
    this.topicNoticeState.set(null);
    const { id, createdAt } = conversation;
    this.conversationState.set({ id, createdAt });
    for (const saved of conversation.asks)
      this.ask(saved.question, {
        mode: saved.mode,
        filters: saved.filters,
        origin: 'restore',
      });
  }

  setMode(mode: SearchMode): void {
    this.modeState.set(mode);
  }

  ask(question: string, options: AskOptions = {}): void {
    const {
      mode = this.modeState(),
      filters = NO_FILTERS,
      origin = 'typed',
    } = options;
    const topic = this.topicSlug();
    const trimmed = question.trim();
    if (!topic || !trimmed) return;
    this.topicNoticeState.set(null);
    this.asks.next({
      id: this.nextId++,
      rev: this.nextRev++,
      topic,
      question: trimmed,
      mode,
      filters,
      origin,
    });
  }

  retry(message: ChatMessage): void {
    this.rerun(message, { filters: message.filters, origin: 'retry' });
  }

  /** Re-runs the same message with new filters (the conversation does not grow). */
  refine(message: ChatMessage, filters: SearchFilters): void {
    this.usage.track({ type: 'filter', filterCount: countFilters(filters) });
    this.rerun(message, {
      filters,
      origin: 'refine',
      delayMs: REFINE_DEBOUNCE_MS,
    });
  }

  loadMore(message: ChatMessage): void {
    if (message.response?.nextOffset == null || message.loadingMore) return;
    this.mores.next(message);
  }

  open(
    topic: string,
    doc: DocumentRef,
    from?: Pick<ChatMessage, 'id' | 'question' | 'response'>,
  ): void {
    const index = from?.response?.items.findIndex((hit) => hit.id === doc.id);
    this.usage.track({
      type: 'open_doc',
      position: index === undefined || index < 0 ? null : index + 1,
    });
    this.historyState.set([]);
    this.openState.set({
      topic,
      id: doc.id,
      title: doc.title,
      messageId: from?.id ?? null,
      question: from?.question ?? null,
    });
  }

  /** Opens a related document in the same panel, remembering the current one. */
  openWithin(doc: DocumentRef): void {
    const current = this.openState();
    if (!current) return;
    this.historyState.update((history) => [...history, current]);
    this.openState.set({ ...current, id: doc.id, title: doc.title });
  }

  back(): void {
    const history = this.historyState();
    const previous = history.at(-1);
    if (!previous) return;
    this.historyState.set(history.slice(0, -1));
    this.openState.set(previous);
  }

  close(): void {
    this.historyState.set([]);
    this.openState.set(null);
  }

  private reset(): void {
    // A restored conversation is saved again (and moves to the top) once its searches settle.
    this.rememberedKey = '';
    this.close();
    this.conversationState.set(freshConversation());
    this.resets.next({ type: 'reset' });
  }

  private rerun(
    message: ChatMessage,
    {
      filters,
      origin,
      delayMs = 0,
    }: Pick<Ask, 'filters' | 'origin' | 'delayMs'>,
  ): void {
    const { id, topic, question, mode } = message;
    this.asks.next({
      id,
      rev: this.nextRev++,
      topic,
      question,
      mode,
      filters,
      delayMs,
      origin,
    });
  }

  private run(ask: Ask): Observable<ChatEvent> {
    const { id, rev } = ask;
    const request = { q: ask.question, mode: ask.mode, filters: ask.filters };
    const search = this.api.search(ask.topic, request);
    // A refine waits briefly; switchMap cancels the timer when another chip click arrives (QA-7).
    const delayed = ask.delayMs
      ? timer(ask.delayMs).pipe(switchMap(() => search))
      : search;
    return delayed.pipe(
      tap((response) => this.trackSearch(ask, response)),
      map((response): ChatEvent => ({ type: 'done', id, rev, response })),
      catchError((err: unknown) =>
        of<ChatEvent>({ type: 'failed', id, rev, error: toUiErrorCode(err) }),
      ),
      startWith<ChatEvent>({ type: 'started', ask }),
    );
  }

  private trackSearch(ask: Ask, response: SearchResponse): void {
    const origin = ask.origin ?? 'typed';
    if (origin === 'restore') return;
    this.usage.track({
      type: 'search',
      origin,
      question: ask.question,
      mode: ask.mode,
      filterCount: countFilters(ask.filters),
      total: response.total,
      tookMs: Math.round(response.tookMs),
    });
  }

  private runMore(message: ChatMessage): Observable<ChatEvent> {
    const { id, rev } = message;
    const offset = message.response?.nextOffset ?? 0;
    return this.api
      .search(message.topic, {
        q: message.question,
        mode: message.mode,
        filters: message.filters,
        offset,
      })
      .pipe(
        map((response): ChatEvent => ({
          type: 'more-done',
          id,
          rev,
          response,
        })),
        catchError(() => of<ChatEvent>({ type: 'more-failed', id, rev })),
        startWith<ChatEvent>({ type: 'more-started', id, rev }),
      );
  }
}
