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
  type SearchFilters,
  type SearchMode,
  type TopicList,
} from '@kb-chat/contracts';
import { toUiErrorCode } from '@core/api/api-error.js';
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

/** Conversation state of the chat page (provided on the page, NG-16). */
@Injectable()
export class ChatStore {
  private readonly api = inject(KbApi);
  private readonly storage = safeStorage(inject(DOCUMENT).defaultView);
  private readonly asks = new Subject<Ask>();
  private readonly mores = new Subject<ChatMessage>();
  private nextId = 1;
  private nextRev = 1;

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
      // Per message, a new run (retry, new filters) cancels the one in flight.
      this.asks.pipe(
        groupBy((ask) => ask.id),
        mergeMap((runs) => runs.pipe(switchMap((ask) => this.run(ask)))),
      ),
      this.mores.pipe(mergeMap((message) => this.runMore(message))),
    ).pipe(scan(reduceChat, [] as readonly ChatMessage[])),
    { initialValue: [] as readonly ChatMessage[] },
  );

  private readonly openState = signal<OpenDocument | null>(null);
  readonly openDocument = this.openState.asReadonly();
  /** Documents left through "Veja também", for "← Voltar" inside the panel. */
  private readonly historyState = signal<readonly OpenDocument[]>([]);
  readonly canGoBack = computed(() => this.historyState().length > 0);

  constructor() {
    effect(() => writeModePreference(this.storage, this.modeState()));
  }

  setMode(mode: SearchMode): void {
    this.modeState.set(mode);
  }

  ask(
    question: string,
    mode: SearchMode = this.modeState(),
    filters: SearchFilters = NO_FILTERS,
  ): void {
    const topic = this.topicSlug();
    const trimmed = question.trim();
    if (!topic || !trimmed) return;
    this.asks.next({
      id: this.nextId++,
      rev: this.nextRev++,
      topic,
      question: trimmed,
      mode,
      filters,
    });
  }

  retry(message: ChatMessage): void {
    this.rerun(message, message.filters);
  }

  /** Re-runs the same message with new filters (the conversation does not grow). */
  refine(message: ChatMessage, filters: SearchFilters): void {
    this.rerun(message, filters, REFINE_DEBOUNCE_MS);
  }

  loadMore(message: ChatMessage): void {
    if (message.response?.nextOffset == null || message.loadingMore) return;
    this.mores.next(message);
  }

  open(
    topic: string,
    doc: DocumentRef,
    from?: Pick<ChatMessage, 'id' | 'question'>,
  ): void {
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

  private rerun(
    message: ChatMessage,
    filters: SearchFilters,
    delayMs = 0,
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
      map((response): ChatEvent => ({ type: 'done', id, rev, response })),
      catchError((err: unknown) =>
        of<ChatEvent>({ type: 'failed', id, rev, error: toUiErrorCode(err) }),
      ),
      startWith<ChatEvent>({ type: 'started', ask }),
    );
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
