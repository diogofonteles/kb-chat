export interface LlmMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Real cost when the provider reports it; null means "compute from the price list". */
  readonly usd: number | null;
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
  /** "per-token" spends money and respects the daily cap; "subscription" is covered by a plan (KBC-007). */
  readonly billing: 'per-token' | 'subscription';
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
