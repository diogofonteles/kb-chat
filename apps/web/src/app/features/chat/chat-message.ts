import type {
  SearchFilters,
  SearchMode,
  SearchResponse,
} from '@kb-chat/contracts';
import type { UiErrorCode } from '@core/api/api-error.js';

export const NO_FILTERS: SearchFilters = {
  concepts: [],
  genres: [],
  depths: [],
  relevances: [],
};

export interface Ask {
  readonly id: number;
  /** Increases on every (re)run of a message; late pages of an older run are dropped. */
  readonly rev: number;
  readonly topic: string;
  readonly question: string;
  readonly mode: SearchMode;
  readonly filters: SearchFilters;
}

export interface ChatMessage extends Ask {
  readonly status: 'loading' | 'done' | 'error';
  readonly response: SearchResponse | null;
  readonly error: UiErrorCode | null;
  readonly loadingMore: boolean;
}

export type ChatEvent =
  | { readonly type: 'started'; readonly ask: Ask }
  | {
      readonly type: 'done';
      readonly id: number;
      readonly rev: number;
      readonly response: SearchResponse;
    }
  | {
      readonly type: 'failed';
      readonly id: number;
      readonly rev: number;
      readonly error: UiErrorCode;
    }
  | { readonly type: 'more-started'; readonly id: number; readonly rev: number }
  | {
      readonly type: 'more-done';
      readonly id: number;
      readonly rev: number;
      readonly response: SearchResponse;
    }
  | { readonly type: 'more-failed'; readonly id: number; readonly rev: number };

type Messages = readonly ChatMessage[];

const toLoading = (ask: Ask): ChatMessage => ({
  ...ask,
  status: 'loading',
  response: null,
  error: null,
  loadingMore: false,
});

/** A re-run keeps the previous results on screen (with the filter bar) until the new ones arrive. */
function upsert(messages: Messages, ask: Ask): Messages {
  const exists = messages.some((message) => message.id === ask.id);
  if (!exists) return [...messages, toLoading(ask)];
  return messages.map((message) =>
    message.id === ask.id
      ? { ...toLoading(ask), response: message.response }
      : message,
  );
}

/** Applies a change only to the message's current run (a stale rev is ignored). */
function patchRun(
  messages: Messages,
  target: { readonly id: number; readonly rev: number },
  change: (message: ChatMessage) => Partial<ChatMessage>,
): Messages {
  return messages.map((message) =>
    message.id === target.id && message.rev === target.rev
      ? { ...message, ...change(message) }
      : message,
  );
}

function appendPage(
  previous: SearchResponse | null,
  page: SearchResponse,
): SearchResponse {
  return previous
    ? { ...page, items: [...previous.items, ...page.items] }
    : page;
}

const HANDLERS: {
  [K in ChatEvent['type']]: (
    m: Messages,
    e: Extract<ChatEvent, { type: K }>,
  ) => Messages;
} = {
  started: (m, e) => upsert(m, e.ask),
  done: (m, e) =>
    patchRun(m, e, () => ({ status: 'done', response: e.response })),
  failed: (m, e) => patchRun(m, e, () => ({ status: 'error', error: e.error })),
  'more-started': (m, e) => patchRun(m, e, () => ({ loadingMore: true })),
  'more-done': (m, e) =>
    patchRun(m, e, (message) => ({
      loadingMore: false,
      response: appendPage(message.response, e.response),
    })),
  'more-failed': (m, e) => patchRun(m, e, () => ({ loadingMore: false })),
};

/** Pure reducer of the conversation; a re-run (retry or new filters) replaces its message in place. */
export function reduceChat(messages: Messages, event: ChatEvent): Messages {
  const handler = HANDLERS[event.type] as (
    m: Messages,
    e: ChatEvent,
  ) => Messages;
  return handler(messages, event);
}

export const hasFilters = (filters: SearchFilters): boolean =>
  Object.values(filters).some((values) => values.length > 0);
