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
  /**
   * Whether a call estimated at this many US$ still fits the person's monthly cap, with the
   * spend of their calls in flight; when true, the estimate stays reserved until `settle`.
   */
  allowed(estimateUsd: number): Promise<boolean>;
  /** The call ended: give back its reservation and count what it really cost. */
  settle(estimateUsd: number, usd: number): void;
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
    const { models, reserved } = await this.chainFor(
      messages,
      options.maxTokens,
    );
    const stream = this.deps.adapter.streamAgent(messages, tools, {
      ...options,
      models,
    });
    const paid = this.deps.paid;
    if (!paid || reserved === 0) {
      yield* stream;
      return;
    }
    // A reserved paid call counts until it ends; then its real cost (0 when a free model
    // answered). Without a reported usage the whole estimate counts: the cap errs safe.
    let usd = reserved;
    try {
      for await (const chunk of stream) {
        usd = chunk.type === 'usage' ? (chunk.usage.usd ?? reserved) : usd;
        yield chunk;
      }
    } finally {
      paid.settle(reserved, usd);
    }
  }

  /** The free chain, then the paid model when its estimated cost fits the cap. */
  private async chainFor(
    messages: readonly AgentMessage[],
    maxTokens: number,
  ): Promise<{ models: string[]; reserved: number }> {
    const free = [...this.deps.chain()];
    const paid = this.deps.paid;
    if (!paid) return { models: free, reserved: 0 };
    const prompt = messages.map((m) => m.content).join('\n');
    const estimate =
      tokensOf(prompt) * paid.price.input + maxTokens * paid.price.output;
    return (await paid.allowed(estimate))
      ? { models: [...free, paid.model], reserved: estimate }
      : { models: free, reserved: 0 };
  }
}
