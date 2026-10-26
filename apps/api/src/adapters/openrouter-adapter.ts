import { z } from 'zod';
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
import { LlmCapacityError, LlmKeyRejectedError } from '../ports/llm-errors.js';

const API = 'https://openrouter.ai/api/v1';
const BALANCE_TTL_MS = 60_000;
/** A stalled provider must not hold a request (and its reserved key) forever. */
const REQUEST_TIMEOUT_MS = 90_000;
const INFO_TIMEOUT_MS = 10_000;
/** Models per request in a fallback chain; a longer chain goes in windows (ADR 0016). */
export const CHAIN_WINDOW = 3;
/** Statuses after which the next window of the chain is tried. */
const RETRYABLE = new Set([402, 403, 408, 429, 500, 502, 503, 504]);

const modelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      pricing: z.object({ prompt: z.string(), completion: z.string() }),
    }),
  ),
});
const creditsSchema = z.object({
  data: z.object({ total_credits: z.number(), total_usage: z.number() }),
});
const chunkSchema = z.looseObject({
  model: z.string().optional(),
  error: z.looseObject({ message: z.string().optional() }).optional(),
  choices: z
    .array(
      z.looseObject({
        delta: z
          .looseObject({
            content: z.string().nullish(),
            tool_calls: z
              .array(
                z.looseObject({
                  index: z.number().int().nonnegative(),
                  id: z.string().nullish(),
                  function: z
                    .looseObject({
                      name: z.string().nullish(),
                      arguments: z.string().nullish(),
                    })
                    .optional(),
                }),
              )
              .nullish(),
          })
          .optional(),
      }),
    )
    .optional(),
  usage: z
    .looseObject({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      cost: z.number().optional(),
    })
    .nullish(),
});

export interface OpenRouterOptions {
  readonly apiKey: string | undefined;
  readonly model: string;
  /**
   * Model reasoning (thinking). Off by default: with a 2,000-token budget per call a
   * reasoning model may spend it all thinking and return no text (seen with
   * deepseek-v4-flash at 800 tokens), and DeepSeek's thinking mode expects its reasoning
   * sent back on every tool turn, which the OpenAI wire format here does not carry.
   * The search-read loop gives the model room to think between steps instead.
   */
  readonly reasoning?: boolean;
  readonly fetch?: typeof fetch;
}

type Chunk = z.infer<typeof chunkSchema>;
type ToolCallDelta = NonNullable<
  NonNullable<NonNullable<Chunk['choices']>[number]['delta']>['tool_calls']
>[number];

/** AgentMessage → OpenAI chat format (assistant tool_calls, role "tool" with tool_call_id). */
export function toWireMessage(message: AgentMessage): Record<string, unknown> {
  if (message.role === 'tool')
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  if (message.role !== 'assistant' || message.toolCalls.length === 0)
    return { role: message.role, content: message.content };
  return {
    role: 'assistant',
    content: message.content || null,
    tool_calls: message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    })),
  };
}

const toWireTool = (tool: ToolDefinition) => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
});

/** Streamed `delta.tool_calls` fragments, joined by index into complete calls. */
export class ToolCallAccumulator {
  private readonly parts = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  add(delta: ToolCallDelta): void {
    const part = this.parts.get(delta.index) ?? {
      id: '',
      name: '',
      arguments: '',
    };
    if (delta.id) part.id = delta.id;
    part.name += delta.function?.name ?? '';
    part.arguments += delta.function?.arguments ?? '';
    this.parts.set(delta.index, part);
  }

  /** The complete calls in index order; a call without an id gets one from its index. */
  drain(): ToolCall[] {
    const calls = [...this.parts.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, part]) => part.name)
      .map(([index, part]) => ({ ...part, id: part.id || `call_${index}` }));
    this.parts.clear();
    return calls;
  }
}

/** Splits an SSE byte stream into the JSON payloads of its `data:` lines. */
export async function* sseData(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    yield* dataPayloads(lines);
  }
}

function* dataPayloads(lines: readonly string[]): Iterable<string> {
  for (const line of lines)
    if (line.startsWith('data: ')) yield line.slice(6).trim();
}

/** A failure of one window of the chain that the next window may avoid. */
class WindowFailure extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

/** The chain in windows of CHAIN_WINDOW models; one window of the adapter's model without a chain. */
export function chainWindows(chain: readonly string[] | undefined): string[][] {
  if (!chain || chain.length === 0) return [];
  const windows: string[][] = [];
  for (let i = 0; i < chain.length; i += CHAIN_WINDOW)
    windows.push(chain.slice(i, i + CHAIN_WINDOW));
  return windows;
}

/** OpenRouter chat completions with streaming and the real cost in the final usage chunk (ADR 0004). */
export class OpenRouterAdapter implements AgentLlmPort {
  readonly model: string;
  readonly billing = 'per-token' as const;
  private readonly fetch: typeof fetch;
  private cachedBalance: { value: number | null; at: number } | null = null;
  private cachedPrice: LlmPrice | null = null;

  constructor(private readonly options: OpenRouterOptions) {
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
    if (this.cachedPrice) return this.cachedPrice;
    const response = await this.fetch(`${API}/models`, {
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    });
    const model = modelsSchema
      .parse(await response.json())
      .data.find((m) => m.id === this.model);
    if (!model) throw new Error(`Model ${this.model} not listed by OpenRouter`);
    this.cachedPrice = {
      input: Number(model.pricing.prompt),
      output: Number(model.pricing.completion),
    };
    return this.cachedPrice;
  }

  async balance(): Promise<number | null> {
    if (
      this.cachedBalance &&
      Date.now() - this.cachedBalance.at < BALANCE_TTL_MS
    )
      return this.cachedBalance.value;
    const response = await this.fetch(`${API}/credits`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    });
    const parsed = response.ok
      ? creditsSchema.safeParse(await response.json())
      : null;
    const value = parsed?.success
      ? parsed.data.data.total_credits - parsed.data.data.total_usage
      : null;
    this.cachedBalance = { value, at: Date.now() };
    return value;
  }

  async *stream(
    messages: readonly LlmMessage[],
    options: LlmStreamOptions,
  ): AsyncIterable<LlmChunk> {
    for await (const chunk of this.streamAgent(messages, [], options))
      if (chunk.type !== 'tool_call') yield chunk;
  }

  /**
   * Streams text and usage, and each tool call once its arguments are complete. With a
   * fallback chain (`options.models`), each window of up to 3 models is one request; a window
   * that fails before writing anything (rate limit, credit, downtime) hands over to the next.
   */
  async *streamAgent(
    messages: readonly AgentMessage[],
    tools: readonly ToolDefinition[],
    options: AgentStreamOptions,
  ): AsyncIterable<AgentChunk> {
    const windows = chainWindows(options.models);
    const targets = windows.length > 0 ? windows : [null];
    const failures: string[] = [];
    for (const models of targets) {
      const body = this.requestBody(messages, tools, { ...options, models });
      const failure = yield* this.tryWindow(body, options);
      if (failure === null) return;
      failures.push(failure);
    }
    // Without a chain (one's own key and model) a busy model is a provider failure, not the
    // app's free capacity running out.
    if (windows.length === 0)
      throw new Error(`OpenRouter failed: ${failures.join('; ')}`);
    throw new LlmCapacityError('OpenRouter', failures.join('; '));
  }

  /** One window: null when it answered, the reason when the next window should try. */
  private async *tryWindow(
    body: Record<string, unknown>,
    options: AgentStreamOptions,
  ): AsyncGenerator<AgentChunk, string | null> {
    try {
      yield* this.streamWindow(body, options);
      return null;
    } catch (err) {
      if (!(err instanceof WindowFailure)) throw err;
      return err.detail;
    }
  }

  /** One request; a failure before any output is a WindowFailure (the chain may go on). */
  private async *streamWindow(
    body: Record<string, unknown>,
    options: AgentStreamOptions,
  ): AsyncIterable<AgentChunk> {
    const stream = await this.post(body, options.signal);
    const calls = new ToolCallAccumulator();
    const state: StreamState = { model: undefined, wrote: false };
    for await (const data of sseData(stream)) {
      if (data === '[DONE]') break;
      for (const chunk of toChunks(data, calls, state)) {
        state.wrote = true;
        yield chunk;
      }
    }
    for (const call of calls.drain()) yield { type: 'tool_call', call };
  }

  /** The request; `options.models` (one window) replaces the adapter's model. */
  private requestBody(
    messages: readonly AgentMessage[],
    tools: readonly ToolDefinition[],
    options: Omit<AgentStreamOptions, 'models'> & { models: string[] | null },
  ): Record<string, unknown> {
    const toolFields =
      tools.length === 0
        ? {}
        : {
            tools: tools.map(toWireTool),
            tool_choice: options.toolChoice ?? 'auto',
            parallel_tool_calls: true,
          };
    return {
      ...(options.models ? { models: options.models } : { model: this.model }),
      messages: messages.map(toWireMessage),
      ...toolFields,
      max_tokens: options.maxTokens,
      stream: true,
      usage: { include: true },
      reasoning: { enabled: this.options.reasoning ?? false },
    };
  }

  private async post(
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await this.fetch(`${API}/chat/completions`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]),
    });
    if (response.status === 401)
      throw new LlmKeyRejectedError('OpenRouter', 401);
    if (response.status === 403 && !(await isLimitRefusal(response)))
      throw new LlmKeyRejectedError('OpenRouter', 403);
    if (RETRYABLE.has(response.status))
      throw new WindowFailure(`HTTP ${response.status}`);
    if (!response.ok || !response.body)
      throw new Error(`OpenRouter answered ${response.status}`);
    return response.body;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.apiKey ?? ''}`,
      'x-title': 'Nova Alexandria',
    };
  }
}

interface StreamState {
  /** The model that answered, from the chunks (fallbacks bill only it). */
  model: string | undefined;
  /** Something reached the caller: a later failure can no longer move to another window. */
  wrote: boolean;
}

/** A 403 for a spent budget or key limit (carries `limit_source`), not a refused key. */
async function isLimitRefusal(response: Response): Promise<boolean> {
  const text = await response.text().catch(() => '');
  return text.includes('limit_source');
}

function* toChunks(
  data: string,
  calls: ToolCallAccumulator,
  state: StreamState,
): Iterable<LlmChunk> {
  const parsed = chunkSchema.safeParse(JSON.parse(data));
  if (!parsed.success) return;
  state.model ??= parsed.data.model;
  // OpenRouter reports mid-stream provider failures as a chunk with `error`.
  if (parsed.data.error) {
    const detail = `OpenRouter stream error: ${parsed.data.error.message ?? 'unknown'}`;
    if (!state.wrote) throw new WindowFailure(detail);
    throw new Error(detail);
  }
  const delta = parsed.data.choices?.[0]?.delta;
  for (const part of delta?.tool_calls ?? []) calls.add(part);
  if (delta?.content) yield { type: 'token', text: delta.content };
  const usage = parsed.data.usage;
  if (usage) {
    yield {
      type: 'usage',
      usage: {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        usd: usage.cost ?? null,
        ...(state.model && { model: state.model }),
      },
    };
  }
}
