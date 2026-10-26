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
import { tokensOf } from '../modules/spend/index.js';

/** The paid model at the end of a person's chain, while their monthly cap allows (BR-5). */
export interface PaidFallbackGate {
  readonly model: string;
  readonly price: LlmPrice;
  /** Whether a call estimated at this many US$ still fits the person's monthly cap. */
  allowed(estimateUsd: number): Promise<boolean>;
}

export interface HouseLlmDeps {
  /** The OpenRouter adapter with the key this person's house requests use. */
  readonly adapter: AgentLlmPort;
  /** The free chain, read on every call (the master may change it). */
  readonly chain: () => readonly string[];
  readonly paid: PaidFallbackGate | null;
}

const FREE: LlmPrice = { input: 0, output: 0 };

/**
 * The house plan's model (ADR 0016): the free chain through OpenRouter's `models` fallback,
 * plus the paid model only while the person's cap allows. Priced at zero before the call;
 * the real cost comes from OpenRouter's usage (it bills only the model that answered).
 */
export class HouseLlm implements AgentLlmPort {
  readonly billing = 'per-token' as const;

  constructor(private readonly deps: HouseLlmDeps) {}

  get model(): string {
    return this.deps.chain()[0] ?? this.deps.paid?.model ?? 'openrouter';
  }

  configured(): boolean {
    return this.deps.adapter.configured() && this.deps.chain().length > 0;
  }

  maxOutputTokens(requested: number): number {
    return requested;
  }

  async price(): Promise<LlmPrice> {
    return FREE;
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
    const models = await this.chainFor(messages, options.maxTokens);
    yield* this.deps.adapter.streamAgent(messages, tools, {
      ...options,
      models,
    });
  }

  /** The free chain, then the paid model when its estimated cost fits the cap. */
  private async chainFor(
    messages: readonly AgentMessage[],
    maxTokens: number,
  ): Promise<string[]> {
    const free = [...this.deps.chain()];
    const paid = this.deps.paid;
    if (!paid) return free;
    const prompt = messages.map((m) => m.content).join('\n');
    const estimate =
      tokensOf(prompt) * paid.price.input + maxTokens * paid.price.output;
    return (await paid.allowed(estimate)) ? [...free, paid.model] : free;
  }
}
