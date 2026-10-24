import { randomUUID } from 'node:crypto';
import { EMPTY_FILTERS, type Conversation } from '@kb-chat/contracts';

interface ConversationOverrides {
  readonly id?: string;
  readonly topic?: string;
  readonly title?: string;
  readonly updatedAt?: string;
}

const STAMP = '2026-10-24T12:00:00.000Z';

export const aSearchConversation = (
  overrides: ConversationOverrides = {},
): Conversation => {
  const title = overrides.title ?? 'lei do ritmo';
  return {
    kind: 'search',
    id: overrides.id ?? randomUUID(),
    topic: overrides.topic ?? 'hermetismo',
    title,
    createdAt: STAMP,
    updatedAt: overrides.updatedAt ?? STAMP,
    asks: [{ question: title, mode: 'all', filters: EMPTY_FILTERS, total: 3 }],
  };
};

export const aResearchConversation = (
  overrides: ConversationOverrides = {},
): Conversation => {
  const title = overrides.title ?? 'quais são os 5 princípios ocultos';
  return {
    kind: 'research',
    id: overrides.id ?? randomUUID(),
    topic: overrides.topic ?? 'hermetismo',
    title,
    createdAt: STAMP,
    updatedAt: overrides.updatedAt ?? STAMP,
    turns: [
      {
        question: title,
        answer: 'Mentalismo, correspondência, vibração, polaridade e ritmo.',
        sources: [],
        steps: 4,
        usd: 0.012,
        model: 'stub/model',
        interrupted: false,
        at: STAMP,
      },
    ],
  };
};
