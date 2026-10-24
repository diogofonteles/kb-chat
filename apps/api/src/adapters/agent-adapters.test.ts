import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { LlmKeyRejectedError } from '../ports/llm-errors.js';
import type { AgentChunk, AgentLlmPort, AgentMessage } from '../ports/llm.js';
import {
  ANTHROPIC_PRICES,
  AnthropicAdapter,
  anthropicPrice,
} from './anthropic-adapter.js';
import { OpenAiAdapter, openAiPrice } from './openai-adapter.js';

const fixture = (name: string) =>
  readFile(new URL(`../../test/fixtures/llm/${name}`, import.meta.url), 'utf8');

const sse = (text: string) =>
  new Response(text, { headers: { 'content-type': 'text/event-stream' } });

const TOOLS = [
  {
    name: 'search_collection',
    description: 'Searches.',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  },
];
const OPTIONS = { maxTokens: 2000, signal: new AbortController().signal };

async function run(
  llm: AgentLlmPort,
  messages: readonly AgentMessage[],
): Promise<AgentChunk[]> {
  const chunks: AgentChunk[] = [];
  for await (const chunk of llm.streamAgent(messages, TOOLS, OPTIONS))
    chunks.push(chunk);
  return chunks;
}

const bodyOf = (call: Parameters<typeof fetch> | undefined) =>
  JSON.parse(String(call?.[1]?.body));

const headersOf = (call: Parameters<typeof fetch> | undefined) =>
  new Headers(call?.[1]?.headers);

describe('AnthropicAdapter', () => {
  const question: AgentMessage[] = [
    { role: 'system', content: 'Pesquise antes.' },
    { role: 'user', content: 'O que é o ritmo?' },
  ];

  it('streams text, a complete tool call and the cost of the step', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sse(await fixture('anthropic-tool-use.sse')),
    );
    const llm = new AnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-opus-5-5',
      fetch: fetchMock,
    });
    expect(await run(llm, question)).toEqual([
      { type: 'token', text: 'Vou buscar.' },
      {
        type: 'tool_call',
        call: {
          id: 'toolu_1',
          name: 'search_collection',
          arguments: '{"query":"ritmo"}',
        },
      },
      {
        type: 'usage',
        usage: {
          inputTokens: 120,
          outputTokens: 40,
          usd: 120 * 4e-6 + 40 * 20e-6,
        },
      },
    ]);
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      system: 'Pesquise antes.',
      stream: true,
      max_tokens: 8000,
      output_config: { effort: 'medium' },
      fallbacks: 'default',
      tools: [{ name: 'search_collection', eager_input_streaming: true }],
    });
    expect(headersOf(fetchMock.mock.calls[0]).get('x-api-key')).toBe(
      'sk-ant-test',
    );
    expect(JSON.stringify(body)).not.toContain('sk-ant-test');
  });

  it('sends the step back with its thinking block and one tool_result message', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        sse(await fixture('anthropic-tool-use.sse')),
      )
      .mockImplementationOnce(async () =>
        sse(await fixture('anthropic-answer.sse')),
      );
    const llm = new AnthropicAdapter({
      apiKey: 'k',
      model: 'claude-opus-5-5',
      fetch: fetchMock,
    });
    await run(llm, question);
    const chunks = await run(llm, [
      ...question,
      {
        role: 'assistant',
        content: 'Vou buscar.',
        toolCalls: [
          { id: 'toolu_1', name: 'search_collection', arguments: '{}' },
        ],
      },
      { role: 'tool', toolCallId: 'toolu_1', content: '[1] A Lei do Ritmo' },
    ]);
    expect(chunks.filter((c) => c.type === 'token')).toHaveLength(2);
    const usage = chunks.at(-1);
    // Cache writes cost 1.25×, cache reads 0.1× of the input price.
    expect(usage).toMatchObject({
      type: 'usage',
      usage: { inputTokens: 1150, usd: (50 + 125 + 100) * 4e-6 + 10 * 20e-6 },
    });
    const messages = bodyOf(fetchMock.mock.calls[1]).messages;
    expect(messages[1].content[0]).toMatchObject({
      type: 'thinking',
      signature: 'sig-123',
    });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: '[1] A Lei do Ritmo',
        },
      ],
    });
  });

  it('rebuilds a tool turn it did not produce and forces a final answer with toolChoice none', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sse(await fixture('anthropic-answer.sse')),
    );
    const llm = new AnthropicAdapter({
      apiKey: 'k',
      model: 'claude-haiku-5-5',
      fetch: fetchMock,
    });
    const chunks: AgentChunk[] = [];
    for await (const chunk of llm.streamAgent(
      [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'x', name: 'search_collection', arguments: 'not json' },
          ],
        },
        { role: 'tool', toolCallId: 'x', content: 'r' },
      ],
      TOOLS,
      { ...OPTIONS, toolChoice: 'none' },
    ))
      chunks.push(chunk);
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body.tool_choice).toEqual({ type: 'none' });
    expect(body.fallbacks).toBeUndefined();
    expect(body.messages[1].content).toEqual([
      { type: 'tool_use', id: 'x', name: 'search_collection', input: {} },
    ]);
    expect(chunks.some((c) => c.type === 'tool_call')).toBe(false);
  });

  it('turns a refused key into LlmKeyRejectedError', async () => {
    const llm = new AnthropicAdapter({
      apiKey: 'bad',
      model: 'claude-opus-5-5',
      fetch: async () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'authentication_error',
              message: 'invalid x-api-key',
            },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    });
    await expect(run(llm, question)).rejects.toBeInstanceOf(
      LlmKeyRejectedError,
    );
  });

  it('prices unknown models as the dearest and needs a key', async () => {
    expect(anthropicPrice('claude-new')).toEqual(
      ANTHROPIC_PRICES['claude-fable-5-1'],
    );
    const llm = new AnthropicAdapter({
      apiKey: undefined,
      model: 'claude-sonnet-5-5',
    });
    expect(llm.configured()).toBe(false);
    expect(await llm.price()).toEqual({ input: 2e-6, output: 10e-6 });
    expect(await llm.balance()).toBeNull();
  });
});

describe('OpenAiAdapter', () => {
  it('accumulates streamed tool-call fragments and prices the usage', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sse(await fixture('openai-tool-call.sse')),
    );
    const llm = new OpenAiAdapter({
      apiKey: 'sk-oa',
      model: 'gpt-5.4-mini',
      fetch: fetchMock,
    });
    const chunks = await run(llm, [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'a', name: 'search_collection', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: 'a', content: 'r' },
    ]);
    expect(chunks).toEqual([
      {
        type: 'usage',
        usage: {
          inputTokens: 200,
          outputTokens: 20,
          usd: 200 * 0.75e-6 + 20 * 4.5e-6,
        },
      },
      {
        type: 'tool_call',
        call: {
          id: 'call_1',
          name: 'search_collection',
          arguments: '{"query":"ritmo"}',
        },
      },
    ]);
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body).toMatchObject({
      tool_choice: 'auto',
      max_completion_tokens: 2000,
      stream_options: { include_usage: true },
    });
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'a',
          type: 'function',
          function: { name: 'search_collection', arguments: '{}' },
        },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'a',
      content: 'r',
    });
    expect(headersOf(fetchMock.mock.calls[0]).get('authorization')).toBe(
      'Bearer sk-oa',
    );
  });

  it('streams plain answers and rejects refused keys and failures', async () => {
    const ok = new OpenAiAdapter({
      apiKey: 'k',
      model: 'gpt-x',
      fetch: async () =>
        sse(
          'data: {"choices":[{"delta":{"content":"oi"}}]}\n\ndata: [DONE]\n\n',
        ),
    });
    const tokens = [];
    for await (const chunk of ok.stream(
      [{ role: 'user', content: 'q' }],
      OPTIONS,
    ))
      tokens.push(chunk);
    expect(tokens).toEqual([{ type: 'token', text: 'oi' }]);
    expect(openAiPrice('gpt-x')).toEqual({ input: 5e-6, output: 30e-6 });
    expect(await ok.balance()).toBeNull();
    const refused = new OpenAiAdapter({
      apiKey: 'k',
      model: 'm',
      fetch: async () => new Response('', { status: 401 }),
    });
    await expect(run(refused, [])).rejects.toBeInstanceOf(LlmKeyRejectedError);
    const down = new OpenAiAdapter({
      apiKey: undefined,
      model: 'm',
      fetch: async () => new Response('', { status: 500 }),
    });
    expect(down.configured()).toBe(false);
    await expect(run(down, [])).rejects.toThrow('OpenAI answered 500');
  });
});
