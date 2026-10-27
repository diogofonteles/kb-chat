import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
  BetaToolUnion,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
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
  ToolDefinition,
} from '../ports/llm.js';

/** The current Opus, the default for the Anthropic API (claude-api skill, 2026-10). */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';

/**
 * US$ per token, from Anthropic's price list (2026-10). A model missing here is priced as the
 * most expensive one, so the daily cap (ADR 0004) errs on the safe side.
 */
export const ANTHROPIC_PRICES: Readonly<Record<string, LlmPrice>> = {
  'claude-opus-5-5': { input: 4e-6, output: 20e-6 },
  'claude-sonnet-5-5': { input: 2e-6, output: 10e-6 },
  'claude-haiku-5-5': { input: 0.1e-6, output: 0.5e-6 },
  'claude-fable-5-1': { input: 10e-6, output: 50e-6 },
};
const MOST_EXPENSIVE: LlmPrice = { input: 10e-6, output: 50e-6 };

/** Models that accept the server-side refusal fallback (beta, `fallbacks: "default"`). */
const FALLBACK_MODELS = new Set([
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-fable-5-1',
]);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Thinking is always on in the current models and counts toward max_tokens. */
const MIN_OUTPUT_TOKENS = 8000;
const REQUEST_TIMEOUT_MS = 120_000;
/** Assistant turns kept for replay (thinking blocks must come back unchanged). */
const MAX_REPLAYS = 200;

export interface AnthropicOptions {
  readonly apiKey: string | undefined;
  readonly model: string;
  readonly fetch?: typeof fetch;
}

export const anthropicPrice = (model: string): LlmPrice =>
  ANTHROPIC_PRICES[model] ?? MOST_EXPENSIVE;

/** Cache writes cost 1.25× input and cache reads 0.1× (prompt caching price list). */
export function anthropicCost(model: string, usage: BetaUsage): number {
  const price = anthropicPrice(model);
  const input =
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) * 1.25 +
    (usage.cache_read_input_tokens ?? 0) * 0.1;
  return input * price.input + usage.output_tokens * price.output;
}

const toTool = (tool: ToolDefinition): BetaToolUnion => ({
  name: tool.name,
  description: tool.description,
  input_schema: { type: 'object', ...tool.parameters },
  eager_input_streaming: true,
});

function parseInput(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const isAuthError = (err: unknown): boolean =>
  err instanceof Anthropic.AuthenticationError ||
  err instanceof Anthropic.PermissionDeniedError;

/**
 * Anthropic Messages API with streaming and tool use (ADR 0006/0007), through the official
 * SDK. Tool calls are emitted once the message is complete, from the SDK's parsed input.
 * Each assistant turn with tools is kept so that its thinking blocks go back unchanged on
 * the next step, as the API requires.
 */
export class AnthropicAdapter implements AgentLlmPort {
  readonly model: string;
  /** The context window of Claude models: sizes the exhaustive sweep's batches (KBC-030). */
  readonly contextTokens = 200_000;
  readonly billing = 'per-token' as const;
  private readonly client: Anthropic;
  private readonly replays = new Map<string, BetaContentBlockParam[]>();

  constructor(private readonly options: AnthropicOptions) {
    this.model = options.model;
    this.client = new Anthropic({
      apiKey: options.apiKey ?? 'unset',
      fetch: options.fetch,
      maxRetries: 1,
      timeout: REQUEST_TIMEOUT_MS,
    });
  }

  configured(): boolean {
    return Boolean(this.options.apiKey);
  }

  maxOutputTokens(requested: number): number {
    return Math.max(requested, MIN_OUTPUT_TOKENS);
  }

  async price(): Promise<LlmPrice> {
    return anthropicPrice(this.model);
  }

  /** The Anthropic API has no balance endpoint for a plain key. */
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
    const stream = this.client.beta.messages.stream(
      this.params(messages, tools, options),
      { signal: options.signal },
    );
    try {
      for await (const event of stream) yield* textOf(event);
      yield* this.finish(await stream.finalMessage());
    } catch (err) {
      if (isAuthError(err)) throw new LlmKeyRejectedError('Anthropic', 401);
      throw err;
    }
  }

  private params(
    messages: readonly AgentMessage[],
    tools: readonly ToolDefinition[],
    options: AgentStreamOptions,
  ): BetaMessageStreamParams {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const fallback = FALLBACK_MODELS.has(this.model);
    return {
      model: this.model,
      max_tokens: this.maxOutputTokens(options.maxTokens),
      ...(system ? { system } : {}),
      messages: this.toMessages(messages),
      ...(tools.length > 0 ? { tools: tools.map(toTool) } : {}),
      ...(tools.length > 0 && options.toolChoice === 'none'
        ? { tool_choice: { type: 'none' as const } }
        : {}),
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
    };
  }

  private *finish(message: BetaMessage): Iterable<AgentChunk> {
    if (message.stop_reason === 'refusal')
      throw new Error('Anthropic declined the request (refusal)');
    // A tool input cut by max_tokens may still parse: never run it.
    const truncated = message.stop_reason === 'max_tokens';
    const calls = truncated ? [] : toolUses(message.content);
    if (calls.length > 0) this.remember(calls[0]?.id ?? '', message.content);
    for (const call of calls) yield { type: 'tool_call', call };
    yield {
      type: 'usage',
      usage: {
        inputTokens:
          message.usage.input_tokens +
          (message.usage.cache_read_input_tokens ?? 0) +
          (message.usage.cache_creation_input_tokens ?? 0),
        outputTokens: message.usage.output_tokens,
        usd: anthropicCost(this.model, message.usage),
      },
    };
  }

  private remember(id: string, content: readonly BetaContentBlock[]): void {
    this.replays.set(id, content as BetaContentBlockParam[]);
    if (this.replays.size <= MAX_REPLAYS) return;
    const oldest = this.replays.keys().next().value;
    if (oldest !== undefined) this.replays.delete(oldest);
  }

  private toMessages(messages: readonly AgentMessage[]): BetaMessageParam[] {
    const out: BetaMessageParam[] = [];
    for (const message of messages) {
      const param = this.toParam(message);
      if (param) appendMerged(out, param);
    }
    return out;
  }

  private toParam(message: AgentMessage): BetaMessageParam | null {
    if ('toolCalls' in message) return this.assistantParam(message);
    if (!('toolCallId' in message))
      return message.role === 'user'
        ? { role: 'user', content: message.content }
        : null;
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
        },
      ],
    };
  }

  private assistantParam(
    message: Extract<AgentMessage, { role: 'assistant' }>,
  ): BetaMessageParam | null {
    const replay = this.replays.get(message.toolCalls[0]?.id ?? '');
    if (replay) return { role: 'assistant', content: replay };
    const content: BetaContentBlockParam[] = [
      ...(message.content
        ? [{ type: 'text' as const, text: message.content }]
        : []),
      ...message.toolCalls.map((call) => ({
        type: 'tool_use' as const,
        id: call.id,
        name: call.name,
        input: parseInput(call.arguments),
      })),
    ];
    return content.length > 0 ? { role: 'assistant', content } : null;
  }
}

function* textOf(event: BetaRawMessageStreamEvent): Iterable<AgentChunk> {
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta')
    yield { type: 'token', text: event.delta.text };
}

function toolUses(content: readonly BetaContentBlock[]) {
  return content.flatMap((block) =>
    block.type === 'tool_use'
      ? [
          {
            id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        ]
      : [],
  );
}

const asBlocks = (
  content: BetaMessageParam['content'],
): BetaContentBlockParam[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : content;

/** Tool results of one step go back in a single user message (parallel tool use). */
function appendMerged(out: BetaMessageParam[], param: BetaMessageParam): void {
  const last = out.at(-1);
  if (!last || last.role !== param.role) {
    out.push(param);
    return;
  }
  out[out.length - 1] = {
    role: last.role,
    content: [...asBlocks(last.content), ...asBlocks(param.content)],
  };
}
