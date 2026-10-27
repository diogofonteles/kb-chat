import type { AgentMessage } from '../../ports/llm.js';

/** A conversation as one text, for token estimates and compaction. */
export const promptText = (messages: readonly AgentMessage[]): string =>
  messages
    .map((m) =>
      m.role === 'assistant'
        ? m.content + m.toolCalls.map((c) => c.arguments).join('')
        : m.content,
    )
    .join('\n');
