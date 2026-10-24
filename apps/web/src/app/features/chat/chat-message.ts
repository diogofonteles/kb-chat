import type { SearchMode, SearchResponse } from '@kb-chat/contracts';
import type { UiErrorCode } from '@core/api/api-error.js';

export interface Ask {
  readonly id: number;
  readonly topic: string;
  readonly question: string;
  readonly mode: SearchMode;
}

export interface ChatMessage extends Ask {
  readonly status: 'loading' | 'done' | 'error';
  readonly response: SearchResponse | null;
  readonly error: UiErrorCode | null;
}

export type ChatEvent =
  | { readonly type: 'started'; readonly ask: Ask }
  | {
      readonly type: 'done';
      readonly id: number;
      readonly response: SearchResponse;
    }
  | {
      readonly type: 'failed';
      readonly id: number;
      readonly error: UiErrorCode;
    };

const toLoading = (ask: Ask): ChatMessage => ({
  ...ask,
  status: 'loading',
  response: null,
  error: null,
});

function upsert(
  messages: readonly ChatMessage[],
  next: ChatMessage,
): readonly ChatMessage[] {
  const exists = messages.some((message) => message.id === next.id);
  return exists
    ? messages.map((message) => (message.id === next.id ? next : message))
    : [...messages, next];
}

function patch(
  messages: readonly ChatMessage[],
  id: number,
  change: Partial<ChatMessage>,
): readonly ChatMessage[] {
  return messages.map((message) =>
    message.id === id ? { ...message, ...change } : message,
  );
}

/** Pure reducer of the conversation; a retried ask replaces its message in place. */
export function reduceChat(
  messages: readonly ChatMessage[],
  event: ChatEvent,
): readonly ChatMessage[] {
  if (event.type === 'started') return upsert(messages, toLoading(event.ask));
  if (event.type === 'done')
    return patch(messages, event.id, {
      status: 'done',
      response: event.response,
    });
  return patch(messages, event.id, { status: 'error', error: event.error });
}
