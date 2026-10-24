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
  type SearchHit,
  type SearchMode,
  type TopicList,
} from '@kb-chat/contracts';
import { toUiErrorCode } from '@core/api/api-error.js';
import { KbApi, topicsUrl } from '@core/api/kb-api.js';
import {
  Subject,
  catchError,
  map,
  mergeMap,
  of,
  scan,
  startWith,
  type Observable,
} from 'rxjs';
import {
  reduceChat,
  type Ask,
  type ChatEvent,
  type ChatMessage,
} from './chat-message.js';
import { readModePreference, writeModePreference } from './mode-preference.js';

export interface OpenDocument {
  readonly topic: string;
  readonly id: string;
  readonly title: string;
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
  private nextId = 1;

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
    this.asks.pipe(
      mergeMap((ask) => this.run(ask)),
      scan(reduceChat, [] as readonly ChatMessage[]),
    ),
    { initialValue: [] as readonly ChatMessage[] },
  );

  private readonly openState = signal<OpenDocument | null>(null);
  readonly openDocument = this.openState.asReadonly();

  constructor() {
    effect(() => writeModePreference(this.storage, this.modeState()));
  }

  setMode(mode: SearchMode): void {
    this.modeState.set(mode);
  }

  ask(question: string, mode: SearchMode = this.modeState()): void {
    const topic = this.topicSlug();
    const trimmed = question.trim();
    if (!topic || !trimmed) return;
    this.asks.next({ id: this.nextId++, topic, question: trimmed, mode });
  }

  retry(message: ChatMessage): void {
    this.asks.next({
      id: message.id,
      topic: message.topic,
      question: message.question,
      mode: message.mode,
    });
  }

  open(topic: string, hit: Pick<SearchHit, 'id' | 'title'>): void {
    this.openState.set({ topic, id: hit.id, title: hit.title });
  }

  close(): void {
    this.openState.set(null);
  }

  private run(ask: Ask): Observable<ChatEvent> {
    return this.api.search(ask.topic, { q: ask.question, mode: ask.mode }).pipe(
      map((response): ChatEvent => ({ type: 'done', id: ask.id, response })),
      catchError((err: unknown) =>
        of<ChatEvent>({
          type: 'failed',
          id: ask.id,
          error: toUiErrorCode(err),
        }),
      ),
      startWith<ChatEvent>({ type: 'started', ask }),
    );
  }
}
