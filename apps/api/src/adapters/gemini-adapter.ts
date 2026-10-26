import { z } from 'zod';
import { LlmCapacityError, LlmKeyRejectedError } from '../ports/llm-errors.js';
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

const API = 'https://generativelanguage.googleapis.com/v1beta';
const REQUEST_TIMEOUT_MS = 120_000;
/** Assistant turns kept for replay: Gemini needs its thought signatures back unchanged. */
const MAX_REPLAYS = 200;

/** Free-tier models with function calling (Gemini pricing page, 2026-10-26). */
export const GEMINI_FAST_MODEL = 'gemini-3.5-flash-lite';
export const GEMINI_DEEP_MODEL = 'gemini-3.8-flash';

/**
 * US$ per token on the paid tier (Gemini pricing page, 2026-10-26; the Flash prices double on
 * 2027-01-01). Unknown models are priced as the dearest, so the cap errs on the safe side.
 */
export const GEMINI_PRICES: Readonly<Record<string, LlmPrice>> = {
  'gemini-3.8-flash': { input: 0.75e-6, output: 3.75e-6 },
  'gemini-3.6-flash': { input: 0.75e-6, output: 3.75e-6 },
  'gemini-3.5-flash-lite': { input: 0.3e-6, output: 2.5e-6 },
};
const MOST_EXPENSIVE: LlmPrice = { input: 1.5e-6, output: 7.5e-6 };
const FREE: LlmPrice = { input: 0, output: 0 };

type Part = Record<string, unknown>;

interface GeminiTurn {
  readonly role: 'user' | 'model';
  readonly parts: Part[];
}

const isResponses = (turn: GeminiTurn): boolean =>
  turn.role === 'user' &&
  turn.parts.every((part) => 'functionResponse' in part);

/** The results of one step's parallel calls travel together, in one user turn. */
function appendTurn(contents: GeminiTurn[], turn: GeminiTurn): void {
  const last = contents.at(-1);
  if (last && isResponses(last) && isResponses(turn))
    last.parts.push(...turn.parts);
  else contents.push(turn);
}

const partSchema = z.looseObject({
  text: z.string().optional(),
  thought: z.boolean().optional(),
  thoughtSignature: z.string().optional(),
  functionCall: z
    .looseObject({
      id: z.string().optional(),
      name: z.string(),
      args: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});
const chunkSchema = z.looseObject({
  candidates: z
    .array(
      z.looseObject({
        content: z
          .looseObject({ parts: z.array(partSchema).optional() })
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  usageMetadata: z
    .looseObject({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
      thoughtsTokenCount: z.number().optional(),
    })
    .optional(),
  error: z.looseObject({ message: z.string().optional() }).optional(),
});

export interface GeminiOptions {
  readonly apiKey: string | undefined;
  readonly model: string;
  /** The Google AI Studio free tier: answers cost US$ 0 (and may train Google's models). */
  readonly freeTier: boolean;
  readonly fetch?: typeof fetch;
}

type Chunk = z.infer<typeof chunkSchema>;

export const geminiPrice = (model: string): LlmPrice =>
  GEMINI_PRICES[model] ?? MOST_EXPENSIVE;

const toDeclaration = (tool: ToolDefinition) => ({
  name: tool.name,
  description: tool.description,
  // Full JSON Schema, not the OpenAPI subset of `parameters`.
  parametersJsonSchema: { type: 'object', ...tool.parameters },
});

function parseArgs(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text || '{}');
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : {};
  } catch {
    return {};
  }
}

/** One streamed call: its text, its tool calls with their raw parts, and the usage. */
interface CallState {
  readonly parts: Part[];
  readonly calls: ToolCall[];
  usage: Chunk['usageMetadata'];
}

/**
 * Gemini API (Google AI Studio key) with streaming and function calling (KBC-023): REST
 * `streamGenerateContent?alt=sse`, the key in `x-goog-api-key`. The model's parts of a
 * tool-calling turn are kept and sent back unchanged (thought signatures, ids).
 */
export class GeminiAdapter implements AgentLlmPort {
  readonly model: string;
  readonly billing: 'per-token' | 'free';
  private readonly fetch: typeof fetch;
  private readonly replays = new Map<string, Part[]>();

  constructor(private readonly options: GeminiOptions) {
    this.model = options.model;
    this.billing = options.freeTier ? 'free' : 'per-token';
    this.fetch = options.fetch ?? fetch;
  }

  configured(): boolean {
    return Boolean(this.options.apiKey);
  }

  maxOutputTokens(requested: number): number {
    return requested;
  }

  async price(): Promise<LlmPrice> {
    return this.options.freeTier ? FREE : geminiPrice(this.model);
  }

  async balance(): Promise<number | null> {
    return null;
  }

  async *stream(
    messages: readonly LlmMessage[],
    options: LlmStreamOptions,
  ): AsyncIterable<LlmChunk> {
    for await (const chunk of this.streamAgent(messages, [], options))
      if (chunk.type !== 'tool_call') yield chunk;
  }

  async *streamAgent(
    messages: readonly AgentMessage[],
    tools: readonly ToolDefinition[],
    options: AgentStreamOptions,
  ): AsyncIterable<AgentChunk> {
    const body = await this.post(
      this.requestBody(messages, tools, options),
      options.signal,
    );
    const state: CallState = { parts: [], calls: [], usage: undefined };
    for await (const data of sseData(body)) yield* this.chunks(data, state);
    if (state.calls.length > 0)
      this.remember(state.calls[0]?.id ?? '', state.parts);
    for (const call of state.calls) yield { type: 'tool_call', call };
    yield { type: 'usage', usage: await this.usageOf(state) };
  }

  private *chunks(data: string, state: CallState): Iterable<LlmChunk> {
    const parsed = chunkSchema.safeParse(JSON.parse(data));
    if (!parsed.success) return;
    if (parsed.data.error)
      throw new Error(
        `Gemini stream error: ${parsed.data.error.message ?? 'unknown'}`,
      );
    if (parsed.data.usageMetadata) state.usage = parsed.data.usageMetadata;
    for (const part of parsed.data.candidates?.[0]?.content?.parts ?? []) {
      state.parts.push(part);
      if (part.functionCall)
        state.calls.push(this.callOf(part.functionCall, state.calls.length));
      else if (part.text && !part.thought)
        yield { type: 'token', text: part.text };
    }
  }

  private callOf(
    call: NonNullable<z.infer<typeof partSchema>['functionCall']>,
    index: number,
  ): ToolCall {
    return {
      id: call.id ?? `gemini_${Date.now().toString(36)}_${index}`,
      name: call.name,
      arguments: JSON.stringify(call.args ?? {}),
    };
  }

  private async usageOf(state: CallState) {
    const usage = state.usage;
    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens =
      (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
    const price = await this.price();
    const usd = usage
      ? inputTokens * price.input + outputTokens * price.output
      : null;
    return { inputTokens, outputTokens, usd };
  }

  private requestBody(
    messages: readonly AgentMessage[],
    tools: readonly ToolDefinition[],
    options: AgentStreamOptions,
  ): Record<string, unknown> {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const toolFields =
      tools.length === 0
        ? {}
        : {
            tools: [{ functionDeclarations: tools.map(toDeclaration) }],
            toolConfig: {
              functionCallingConfig: {
                mode: options.toolChoice === 'none' ? 'NONE' : 'AUTO',
              },
            },
          };
    return {
      ...(system && { systemInstruction: { parts: [{ text: system }] } }),
      contents: this.toContents(messages),
      ...toolFields,
      generationConfig: { maxOutputTokens: options.maxTokens },
    };
  }

  /** The conversation in Gemini's turns; tool results go back as one user turn per step. */
  private toContents(messages: readonly AgentMessage[]): GeminiTurn[] {
    const names = new Map<string, string>();
    const contents: GeminiTurn[] = [];
    for (const message of messages) {
      const turn = this.turnOf(message, names);
      if (turn) appendTurn(contents, turn);
    }
    return contents;
  }

  private turnOf(
    message: AgentMessage,
    names: Map<string, string>,
  ): GeminiTurn | null {
    if ('toolCalls' in message) {
      for (const call of message.toolCalls) names.set(call.id, call.name);
      return { role: 'model', parts: this.modelParts(message) };
    }
    if (message.role === 'tool')
      return {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: message.toolCallId,
              name: names.get(message.toolCallId) ?? 'tool',
              response: { result: message.content },
            },
          },
        ],
      };
    return message.role === 'user'
      ? { role: 'user', parts: [{ text: message.content }] }
      : null;
  }

  /** A model turn exactly as Gemini wrote it when kept, else rebuilt from its text and calls. */
  private modelParts(
    message: Extract<AgentMessage, { role: 'assistant' }>,
  ): Part[] {
    const kept = this.replays.get(message.toolCalls[0]?.id ?? '');
    if (kept) return kept;
    const text = message.content ? [{ text: message.content }] : [];
    const calls = message.toolCalls.map((call) => ({
      functionCall: {
        id: call.id,
        name: call.name,
        args: parseArgs(call.arguments),
      },
    }));
    return [...text, ...calls];
  }

  private async post(
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const url = `${API}/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`;
    const response = await this.fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.options.apiKey ?? '',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]),
    });
    if (response.ok && response.body) return response.body;
    throw await failureOf(response);
  }

  private remember(id: string, parts: Part[]): void {
    this.replays.set(id, parts);
    if (this.replays.size > MAX_REPLAYS) {
      const oldest = this.replays.keys().next().value;
      if (oldest !== undefined) this.replays.delete(oldest);
    }
  }
}

/** Gemini answers a bad key with 400 API_KEY_INVALID or 401/403; 429 is its free-tier limit. */
async function failureOf(response: Response): Promise<Error> {
  const text = await response.text().catch(() => '');
  if (
    response.status === 401 ||
    response.status === 403 ||
    text.includes('API_KEY_INVALID')
  )
    return new LlmKeyRejectedError('Gemini', response.status);
  if (response.status === 429)
    return new LlmCapacityError('Gemini', 'free-tier rate limit');
  return new Error(`Gemini answered ${response.status}`);
}
