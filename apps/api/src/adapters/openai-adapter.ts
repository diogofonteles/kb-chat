import { z } from 'zod';
import { LlmKeyRejectedError } from '../ports/llm-errors.js';
import type {
  AgentChunk,
  AgentLlmPort,
  AgentMessage,
  AgentStreamOptions,
  LlmChunk,
  LlmMessage,
  LlmPrice,
  LlmStreamOptions,
  ToolCall,
  ToolDefinition,
} from '../ports/llm.js';
import { sseData } from './openrouter-adapter.js';

const API = 'https://api.openai.com/v1';
const REQUEST_TIMEOUT_MS = 120_000;

/** A cheap model with tool calling; GPT-5.5 and GPT-5.4 are offered in Settings. */
export const OPENAI_DEFAULT_MODEL = 'gpt-5.4-mini';

/** US$ per token, from OpenAI's price list (2026-10); unknown models priced as the dearest. */
export const OPENAI_PRICES: Readonly<Record<string, LlmPrice>> = {
  'gpt-5.5': { input: 5e-6, output: 30e-6 },
  'gpt-5.4': { input: 2.5e-6, output: 15e-6 },
  'gpt-5.4-mini': { input: 0.75e-6, output: 4.5e-6 },
};
const MOST_EXPENSIVE: LlmPrice = { input: 5e-6, output: 30e-6 };

export const openAiPrice = (model: string): LlmPrice =>
  OPENAI_PRICES[model] ?? MOST_EXPENSIVE;

const toolCallDeltaSchema = z.looseObject({
  index: z.number().int().nonnegative(),
  id: z.string().optional(),
  function: z
    .looseObject({
      name: z.string().optional(),
      arguments: z.string().optional(),
    })
    .optional(),
});
const chunkSchema = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        delta: z
          .looseObject({
            content: z.string().nullish(),
            tool_calls: z.array(toolCallDeltaSchema).nullish(),
          })
          .optional(),
      }),
    )
    .optional(),
  usage: z
    .looseObject({ prompt_tokens: z.number(), completion_tokens: z.number() })
    .nullish(),
});
type ToolCallDelta = z.infer<typeof toolCallDeltaSchema>;

export interface OpenAiOptions {
  readonly apiKey: string | undefined;
  readonly model: string;
  readonly fetch?: typeof fetch;
}

function toWire(message: AgentMessage): Record<string, unknown> {
  if ('toolCalls' in message)
    return {
      role: 'assistant',
      content: message.content || null,
      ...(message.toolCalls.length > 0
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    };
  if ('toolCallId' in message)
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  return { role: message.role, content: message.content };
}

const toTool = (tool: ToolDefinition) => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
});

/** Accumulates streamed tool-call fragments by index (Chat Completions format). */
class ToolCallBuffer {
  private readonly calls = new Map<number, ToolCall>();

  add(delta: ToolCallDelta): void {
    const current = this.calls.get(delta.index) ?? {
      id: '',
      name: '',
      arguments: '',
    };
    this.calls.set(delta.index, {
      id: delta.id ?? current.id,
      name: current.name + (delta.function?.name ?? ''),
      arguments: current.arguments + (delta.function?.arguments ?? ''),
    });
  }

  complete(): ToolCall[] {
    return [...this.calls.values()].filter((call) => call.name !== '');
  }
}

/** OpenAI Chat Completions with streaming and tool calling (KBC-007). */
export class OpenAiAdapter implements AgentLlmPort {
  readonly model: string;
  readonly billing = 'per-token' as const;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: OpenAiOptions) {
    this.model = options.model;
    this.fetch = options.fetch ?? fetch;
  }

  configured(): boolean {
    return Boolean(this.options.apiKey);
  }

  maxOutputTokens(requested: number): number {
    return requested;
  }

  async price(): Promise<LlmPrice> {
    return openAiPrice(this.model);
  }

  /** OpenAI exposes no balance for an API key. */
  async balance(): Promise<number | null> {
    return null;
  }

  stream(
    messages: readonly LlmMessage[],
    options: LlmStreamOptions,
  ): AsyncIterable<LlmChunk> {
    return this.streamAgent(messages, [], options) as AsyncIterable<LlmChunk>;
  }

  async *streamAgent(
    messages: readonly AgentMessage[],
    tools: readonly ToolDefinition[],
    options: AgentStreamOptions,
  ): AsyncIterable<AgentChunk> {
    const body = await this.request(messages, tools, options);
    const buffer = new ToolCallBuffer();
    for await (const data of sseData(body)) {
      if (data === '[DONE]') break;
      yield* this.toChunks(data, buffer);
    }
    for (const call of buffer.complete()) yield { type: 'tool_call', call };
  }

  private async request(
    messages: readonly AgentMessage[],
    tools: readonly ToolDefinition[],
    options: AgentStreamOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await this.fetch(`${API}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey ?? ''}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(this.body(messages, tools, options)),
      signal: AbortSignal.any([
        options.signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]),
    });
    if (response.status === 401 || response.status === 403)
      throw new LlmKeyRejectedError('OpenAI', response.status);
    if (!response.ok || !response.body)
      throw new Error(`OpenAI answered ${response.status}`);
    return response.body;
  }

  private body(
    messages: readonly AgentMessage[],
    tools: readonly ToolDefinition[],
    options: AgentStreamOptions,
  ): Record<string, unknown> {
    return {
      model: this.model,
      messages: messages.map(toWire),
      ...(tools.length > 0
        ? {
            tools: tools.map(toTool),
            tool_choice: options.toolChoice ?? 'auto',
          }
        : {}),
      // GPT-5 models take max_completion_tokens (reasoning counts toward it).
      max_completion_tokens: options.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
  }

  private *toChunks(
    data: string,
    buffer: ToolCallBuffer,
  ): Iterable<AgentChunk> {
    const parsed = chunkSchema.safeParse(JSON.parse(data));
    if (!parsed.success) return;
    const delta = parsed.data.choices?.[0]?.delta;
    if (delta?.content) yield { type: 'token', text: delta.content };
    for (const call of delta?.tool_calls ?? []) buffer.add(call);
    const usage = parsed.data.usage;
    if (!usage) return;
    const price = openAiPrice(this.model);
    yield {
      type: 'usage',
      usage: {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        usd:
          usage.prompt_tokens * price.input +
          usage.completion_tokens * price.output,
      },
    };
  }
}
