export interface LlmMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Real cost when the provider reports it; null means "compute from the price list". */
  readonly usd: number | null;
  /** The model that answered, when the provider names it (OpenRouter's fallbacks, KBC-022). */
  readonly model?: string;
}

export type LlmChunk =
  | { readonly type: 'token'; readonly text: string }
  | { readonly type: 'usage'; readonly usage: LlmUsage };

/** US$ per token. */
export interface LlmPrice {
  readonly input: number;
  readonly output: number;
}

export interface LlmStreamOptions {
  readonly maxTokens: number;
  readonly signal: AbortSignal;
}

/** A chat model behind a paid API (ADR 0004). */
export interface LlmPort {
  readonly model: string;
  /**
   * "per-token" spends money and respects the daily cap; "subscription" is covered by a plan
   * (KBC-007); "free" costs nothing (Gemini's free tier, KBC-023).
   */
  readonly billing: 'per-token' | 'subscription' | 'free';
  /** False when no API key is configured: answers are refused with LLM_NOT_CONFIGURED. */
  configured(): boolean;
  price(): Promise<LlmPrice>;
  /** Remaining account credit in US$, or null when it cannot be read. */
  balance(): Promise<number | null>;
  stream(
    messages: readonly LlmMessage[],
    options: LlmStreamOptions,
  ): AsyncIterable<LlmChunk>;
}

/** A tool the model may call (ADR 0006); `parameters` is a JSON Schema object. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Arguments as the model wrote them (JSON text, possibly invalid). */
  readonly arguments: string;
}

/** Messages of a tool-calling conversation. */
export type AgentMessage =
  | LlmMessage
  | {
      readonly role: 'assistant';
      readonly content: string;
      readonly toolCalls: readonly ToolCall[];
    }
  | {
      readonly role: 'tool';
      readonly toolCallId: string;
      readonly content: string;
    };

export type AgentChunk =
  | LlmChunk
  /** A complete tool call, emitted once its arguments finished streaming. */
  | { readonly type: 'tool_call'; readonly call: ToolCall };

export interface AgentStreamOptions extends LlmStreamOptions {
  /** "none" forces a final text answer (used when the step cap is reached). */
  readonly toolChoice?: 'auto' | 'none';
  /**
   * Models to fall back on, in order, for a provider that routes (OpenRouter's `models`,
   * KBC-022); the adapter's own model is used when absent.
   */
  readonly models?: readonly string[];
}

/** A model with native tool calling (OpenRouter, OpenAI, Anthropic; the stub in tests). */
export interface AgentLlmPort extends LlmPort {
  /**
   * The output tokens a call asking for `requested` may really spend: some adapters raise
   * it (Anthropic's thinking floor), and the spend guard prices this, not the request.
   */
  maxOutputTokens(requested: number): number;
  streamAgent(
    messages: readonly AgentMessage[],
    tools: readonly ToolDefinition[],
    options: AgentStreamOptions,
  ): AsyncIterable<AgentChunk>;
}
