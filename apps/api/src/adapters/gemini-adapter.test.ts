import { describe, expect, it, vi } from 'vitest';
import type { AgentChunk, AgentMessage, ToolDefinition } from '../ports/llm.js';
import { LlmCapacityError, LlmKeyRejectedError } from '../ports/llm-errors.js';
import {
  GEMINI_DEEP_MODEL,
  GEMINI_FAST_MODEL,
  GeminiAdapter,
  geminiPrice,
} from './gemini-adapter.js';

/** A recorded `streamGenerateContent?alt=sse` answer: one JSON object per `data:` line. */
const sse = (...chunks: object[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(''));

const TOOLS: ToolDefinition[] = [
  {
    name: 'search_collection',
    description: 'Busca',
    parameters: {
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

const options = { maxTokens: 500, signal: new AbortController().signal };

async function collect(
  adapter: GeminiAdapter,
  messages: AgentMessage[],
  tools = TOOLS,
) {
  const chunks: AgentChunk[] = [];
  for await (const chunk of adapter.streamAgent(messages, tools, options))
    chunks.push(chunk);
  return chunks;
}

function recorder(...responses: Response[]) {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const headers: Headers[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    urls.push(String(url));
    headers.push(new Headers(init?.headers));
    bodies.push(JSON.parse(String(init?.body)));
    return responses.shift() ?? new Response('{}', { status: 500 });
  });
  return { fetchMock, bodies, urls, headers };
}

describe('GeminiAdapter (KBC-023 AC-4, AC-5)', () => {
  it('streams text and prices a free-tier answer at zero, key in the header only', async () => {
    const { fetchMock, bodies, urls, headers } = recorder(
      sse(
        {
          candidates: [
            { content: { parts: [{ text: 'Pensando', thought: true }] } },
          ],
        },
        {
          candidates: [{ content: { parts: [{ text: 'O mentalismo [1]' }] } }],
        },
        {
          candidates: [{ content: { parts: [{ text: ' é o primeiro.' }] } }],
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 8,
            thoughtsTokenCount: 4,
          },
        },
      ),
    );
    const adapter = new GeminiAdapter({
      apiKey: 'AIza-free-key',
      model: GEMINI_FAST_MODEL,
      freeTier: true,
      fetch: fetchMock,
    });
    const chunks = await collect(adapter, [
      { role: 'system', content: 'Regras' },
      { role: 'user', content: 'O que é o mentalismo?' },
    ]);
    expect(chunks).toEqual([
      { type: 'token', text: 'O mentalismo [1]' },
      { type: 'token', text: ' é o primeiro.' },
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 12, usd: 0 } },
    ]);
    expect(adapter.billing).toBe('free');
    expect(urls[0]).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FAST_MODEL}:streamGenerateContent?alt=sse`,
    );
    expect(urls[0]).not.toContain('AIza');
    expect(headers[0]?.get('x-goog-api-key')).toBe('AIza-free-key');
    expect(bodies[0]).toMatchObject({
      systemInstruction: { parts: [{ text: 'Regras' }] },
      contents: [{ role: 'user', parts: [{ text: 'O que é o mentalismo?' }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'search_collection',
              parametersJsonSchema: { type: 'object', required: ['query'] },
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { maxOutputTokens: 500 },
    });
  });

  it('returns the model turn unchanged (thought signature) and answers each call by id and name', async () => {
    const call = {
      functionCall: {
        id: 'call-1',
        name: 'search_collection',
        args: { query: 'mentalismo' },
      },
      thoughtSignature: 'SIG_A',
    };
    const second = {
      functionCall: {
        id: 'call-2',
        name: 'search_collection',
        args: { query: 'Caibalion' },
      },
    };
    const { fetchMock, bodies } = recorder(
      sse({
        candidates: [{ content: { parts: [call, second] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      }),
      sse({ candidates: [{ content: { parts: [{ text: 'Pronto.' }] } }] }),
    );
    const adapter = new GeminiAdapter({
      apiKey: 'k',
      model: GEMINI_DEEP_MODEL,
      freeTier: false,
      fetch: fetchMock,
    });
    const first = await collect(adapter, [{ role: 'user', content: 'q' }]);
    const calls = first.flatMap((c) =>
      c.type === 'tool_call' ? [c.call] : [],
    );
    expect(calls).toEqual([
      {
        id: 'call-1',
        name: 'search_collection',
        arguments: '{"query":"mentalismo"}',
      },
      {
        id: 'call-2',
        name: 'search_collection',
        arguments: '{"query":"Caibalion"}',
      },
    ]);
    await collect(
      adapter,
      [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', toolCalls: calls },
        { role: 'tool', toolCallId: 'call-1', content: 'r1' },
        { role: 'tool', toolCallId: 'call-2', content: 'r2' },
      ],
      TOOLS,
    );
    expect(bodies[1]?.['contents']).toEqual([
      { role: 'user', parts: [{ text: 'q' }] },
      { role: 'model', parts: [call, second] },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-1',
              name: 'search_collection',
              response: { result: 'r1' },
            },
          },
          {
            functionResponse: {
              id: 'call-2',
              name: 'search_collection',
              response: { result: 'r2' },
            },
          },
        ],
      },
    ]);
    // Paid tier: priced from Google's list.
    expect(first.at(-1)).toEqual({
      type: 'usage',
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        usd: 10 * 0.75e-6 + 2 * 3.75e-6,
      },
    });
  });

  it('rebuilds a model turn it did not keep, and forbids tools on the last call', async () => {
    const { fetchMock, bodies } = recorder(
      sse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    );
    const adapter = new GeminiAdapter({
      apiKey: 'k',
      model: 'gemini-x',
      freeTier: false,
      fetch: fetchMock,
    });
    for await (const chunk of adapter.streamAgent(
      [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: 'vou buscar',
          toolCalls: [{ id: 'x', name: 'read', arguments: '{"id":"a"}' }],
        },
        { role: 'tool', toolCallId: 'x', content: 'texto' },
      ],
      TOOLS,
      { ...options, toolChoice: 'none' },
    ))
      void chunk;
    expect(bodies[0]).toMatchObject({
      contents: [
        { role: 'user' },
        {
          role: 'model',
          parts: [
            { text: 'vou buscar' },
            {
              functionCall: { id: 'x', name: 'read', args: { id: 'a' } },
              // A turn this adapter did not keep (an escalation): Google's placeholder.
              thoughtSignature: 'skip_thought_signature_validator',
            },
          ],
        },
        {
          role: 'user',
          parts: [{ functionResponse: { id: 'x', name: 'read' } }],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'NONE' } },
    });
    expect(await adapter.price()).toEqual(geminiPrice('unknown-model'));
  });

  it('reports a refused key, the free-tier limit and a stream error', async () => {
    const make = (response: Response) =>
      new GeminiAdapter({
        apiKey: 'k',
        model: GEMINI_FAST_MODEL,
        freeTier: true,
        fetch: async () => response,
      });
    await expect(
      collect(
        make(
          new Response(
            '{"error":{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}',
            { status: 400 },
          ),
        ),
        [],
      ),
    ).rejects.toBeInstanceOf(LlmKeyRejectedError);
    await expect(
      collect(make(new Response('{}', { status: 403 })), []),
    ).rejects.toBeInstanceOf(LlmKeyRejectedError);
    await expect(
      collect(make(new Response('{}', { status: 429 })), []),
    ).rejects.toBeInstanceOf(LlmCapacityError);
    await expect(
      collect(make(new Response('{}', { status: 500 })), []),
    ).rejects.toThrow(/500/);
    await expect(
      collect(make(sse({ error: { message: 'boom' } })), []),
    ).rejects.toThrow(/boom/);
    const unset = new GeminiAdapter({
      apiKey: undefined,
      model: 'm',
      freeTier: true,
    });
    expect(unset.configured()).toBe(false);
    expect(await unset.balance()).toBeNull();
    expect(unset.maxOutputTokens(7)).toBe(7);
  });

  it('streams plain text through stream()', async () => {
    const adapter = new GeminiAdapter({
      apiKey: 'k',
      model: GEMINI_FAST_MODEL,
      freeTier: true,
      fetch: async () =>
        sse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    });
    const chunks = [];
    for await (const chunk of adapter.stream(
      [{ role: 'user', content: 'Responda apenas: ok' }],
      options,
    ))
      chunks.push(chunk);
    expect(chunks[0]).toEqual({ type: 'token', text: 'ok' });
  });
});
