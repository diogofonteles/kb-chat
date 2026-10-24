import {
  EMPTY_FILTERS,
  type SearchFilters,
  type SearchMode,
  type SearchResponse,
} from '@kb-chat/contracts';
import type { UiErrorCode } from '@core/api/api-error.js';

export const NO_FILTERS: SearchFilters = EMPTY_FILTERS;

export interface Ask {
  readonly id: number;
  /** Increases on every (re)run of a message; late pages of an older run are dropped. */
  readonly rev: number;
  readonly topic: string;
  readonly question: string;
  readonly mode: SearchMode;
  readonly filters: SearchFilters;
  /** Wait before hitting the API, so rapid chip clicks send one search (QA-7). */
  readonly delayMs?: number;
}

export interface ChatMessage extends Ask {
  readonly status: 'loading' | 'done' | 'error';
  readonly response: SearchResponse | null;
  readonly error: UiErrorCode | null;
  readonly loadingMore: boolean;
  readonly moreFailed: boolean;
  /** "facet:value" keys in the order the reader applied them (newest last). */
  readonly filterOrder: readonly string[];
}

export type ChatEvent =
  /** New conversation: results of runs still in flight no longer match any message. */
  | { readonly type: 'reset' }
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

export const filterKey = (facet: string, value: string | number): string =>
  `${facet}:${value}`;

const filterKeys = (filters: SearchFilters): string[] =>
  Object.entries(filters).flatMap(([facet, values]) =>
    (values as readonly (string | number)[]).map((value) =>
      filterKey(facet, value),
    ),
  );

/** Keeps the previous order of filters still selected and appends the new ones. */
function nextOrder(
  previous: readonly string[],
  filters: SearchFilters,
): string[] {
  const current = filterKeys(filters);
  return [
    ...previous.filter((key) => current.includes(key)),
    ...current.filter((key) => !previous.includes(key)),
  ];
}

function toLoading(ask: Ask, previous?: ChatMessage): ChatMessage {
  return {
    ...ask,
    status: 'loading',
    // A re-run keeps the previous results on screen (with the filter bar) until the new ones arrive.
    response: previous?.response ?? null,
    error: null,
    loadingMore: false,
    moreFailed: false,
    filterOrder: nextOrder(previous?.filterOrder ?? [], ask.filters),
  };
}

function upsert(messages: Messages, ask: Ask): Messages {
  const previous = messages.find((message) => message.id === ask.id);
  if (!previous) return [...messages, toLoading(ask)];
  return messages.map((message) =>
    message.id === ask.id ? toLoading(ask, previous) : message,
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
  reset: () => [],
  started: (m, e) => upsert(m, e.ask),
  done: (m, e) =>
    patchRun(m, e, () => ({ status: 'done', response: e.response })),
  failed: (m, e) => patchRun(m, e, () => ({ status: 'error', error: e.error })),
  'more-started': (m, e) =>
    patchRun(m, e, () => ({ loadingMore: true, moreFailed: false })),
  'more-done': (m, e) =>
    patchRun(m, e, (message) => ({
      loadingMore: false,
      response: appendPage(message.response, e.response),
    })),
  'more-failed': (m, e) =>
    patchRun(m, e, () => ({ loadingMore: false, moreFailed: true })),
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
