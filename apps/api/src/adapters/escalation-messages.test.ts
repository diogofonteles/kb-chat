import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  collectEvents,
  escalatingRunner,
} from '../../test/research-factories.js';
import { DEEPEN_MARKER } from '../modules/research/index.js';
import type { AgentLlmPort, AgentMessage } from '../ports/llm.js';
import { AnthropicAdapter } from './anthropic-adapter.js';
import { OpenAiAdapter } from './openai-adapter.js';
import { OpenRouterAdapter } from './openrouter-adapter.js';
import type { StubReply } from './stub-llm-adapter.js';

const fixture = (name: string) =>
  readFile(new URL(`../../test/fixtures/llm/${name}`, import.meta.url), 'utf8');

const sse = (text: string) =>
  new Response(text, { headers: { 'content-type': 'text/event-stream' } });

const search: StubReply = {
  toolCalls: [{ name: 'search_collection', arguments: { query: 'ritmo' } }],
};

/** The deep model's first request after a fast pass that ran out of steps and handed over. */
async function escalationMessages(): Promise<readonly AgentMessage[]> {
  const { runner, deep } = await escalatingRunner(
    {
      script: Array.from({ length: 6 }, () => search),
      finalText: `Achei parte. ${DEEPEN_MARKER} faltam dois`,
    },
    { script: [{ text: 'Os cinco são [1].' }] },
  );
  await collectEvents(
    runner.run({
      topic: 'hermetismo',
      question: 'quais são os 5 princípios ocultos',
      history: [],
      profile: 'fast',
      signal: new AbortController().signal,
    }),
  );
  return deep.lastMessages;
}

async function sentBody(
  llm: AgentLlmPort,
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
  messages: readonly AgentMessage[],
) {
  const options = { maxTokens: 2000, signal: new AbortController().signal };
  for await (const chunk of llm.streamAgent(messages, [], options)) void chunk;
  const call = fetchMock.mock.calls.find(([url]) =>
    /messages|chat\/completions/.test(String(url)),
  );
  return JSON.parse(String(call?.[1]?.body)) as {
    messages: { role: string; content: unknown }[];
    system?: unknown;
  };
}

describe('the deep request after an escalation (ADR 0009)', () => {
  it('never ends on an assistant turn, and carries neither the marker nor the "answer now" note', async () => {
    const messages = await escalationMessages();
    expect(messages.at(-1)?.role).toBe('user');
    const text = JSON.stringify(messages);
    expect(text).not.toContain(DEEPEN_MARKER);
    expect(text).not.toContain('Você usou todos os passos');
    expect(messages.at(-2)).toMatchObject({
      role: 'assistant',
      content: 'Achei parte.',
    });
  });

  it('ends with a user turn in every per-token adapter', async () => {
    const messages = await escalationMessages();
    const anthropicFetch = vi.fn<typeof fetch>(async () =>
      sse(await fixture('anthropic-answer.sse')),
    );
    const anthropic = await sentBody(
      new AnthropicAdapter({
        apiKey: 'sk-ant-test',
        model: 'claude-opus-5-5',
        fetch: anthropicFetch,
      }),
      anthropicFetch,
      messages,
    );
    expect(anthropic.messages.at(-1)?.role).toBe('user');
    expect(JSON.stringify(anthropic.system)).toContain('no máximo 15 passos');
    for (const build of [
      (fetch: typeof globalThis.fetch) =>
        new OpenAiAdapter({ apiKey: 'sk-oa', model: 'gpt-5.4-mini', fetch }),
      (fetch: typeof globalThis.fetch) =>
        new OpenRouterAdapter({ apiKey: 'sk-or', model: 'm', fetch }),
    ]) {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        sse(await fixture('openai-tool-call.sse')),
      );
      const body = await sentBody(build(fetchMock), fetchMock, messages);
      expect(body.messages.at(-1)?.role).toBe('user');
    }
  });
});
