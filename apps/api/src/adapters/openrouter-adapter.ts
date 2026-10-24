import { z } from 'zod';
import type {
  LlmChunk,
  LlmMessage,
  LlmPort,
  LlmPrice,
  LlmStreamOptions,
} from '../ports/llm.js';

const API = 'https://openrouter.ai/api/v1';
const BALANCE_TTL_MS = 60_000;
/** A stalled provider must not hold a request (and its reserved key) forever. */
const REQUEST_TIMEOUT_MS = 90_000;

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
  error: z.looseObject({ message: z.string().optional() }).optional(),
  choices: z
    .array(
      z.looseObject({
        delta: z.looseObject({ content: z.string().nullish() }).optional(),
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
  readonly fetch?: typeof fetch;
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

/** OpenRouter chat completions with streaming and the real cost in the final usage chunk (ADR 0004). */
export class OpenRouterAdapter implements LlmPort {
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

  async price(): Promise<LlmPrice> {
    if (this.cachedPrice) return this.cachedPrice;
    const response = await this.fetch(`${API}/models`);
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
    const response = await this.fetch(`${API}/chat/completions`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: options.maxTokens,
        stream: true,
        usage: { include: true },
        // Reasoning models spend the output budget thinking and may return no text (seen with
        // deepseek-v4-flash at 800 tokens); grounded answers do not need it.
        reasoning: { enabled: false },
      }),
      signal: AbortSignal.any([
        options.signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]),
    });
    if (!response.ok || !response.body)
      throw new Error(`OpenRouter answered ${response.status}`);
    for await (const data of sseData(response.body)) {
      if (data === '[DONE]') return;
      yield* toChunks(data);
    }
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.apiKey ?? ''}`,
      'x-title': 'kb-chat',
    };
  }
}

function* toChunks(data: string): Iterable<LlmChunk> {
  const parsed = chunkSchema.safeParse(JSON.parse(data));
  if (!parsed.success) return;
  // OpenRouter reports mid-stream provider failures as a chunk with `error`.
  if (parsed.data.error)
    throw new Error(
      `OpenRouter stream error: ${parsed.data.error.message ?? 'unknown'}`,
    );
  const text = parsed.data.choices?.[0]?.delta?.content;
  if (text) yield { type: 'token', text };
  const usage = parsed.data.usage;
  if (usage) {
    yield {
      type: 'usage',
      usage: {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        usd: usage.cost ?? null,
      },
    };
  }
}
