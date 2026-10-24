import type {
  LlmChunk,
  LlmMessage,
  LlmPort,
  LlmPrice,
  LlmStreamOptions,
} from '../ports/llm.js';

export interface StubLlmOptions {
  readonly answer?: string;
  readonly balance?: number | null;
  readonly configured?: boolean;
  readonly tokenDelayMs?: number;
}

const DEFAULT_ANSWER = 'Segundo o acervo, a natureza é sétupla [1].';

/**
 * Deterministic model for tests and E2E (KB_CHAT_LLM=stub): streams a fixed answer word
 * by word at US$ 1 per million tokens, so nothing is spent.
 */
export class StubLlmAdapter implements LlmPort {
  readonly model = 'stub/model';
  readonly billing = 'per-token' as const;
  /** Messages of the last call, calls made and tokens handed out, for assertions. */
  lastMessages: readonly LlmMessage[] = [];
  calls = 0;
  yielded = 0;

  constructor(private readonly options: StubLlmOptions = {}) {}

  configured(): boolean {
    return this.options.configured ?? true;
  }

  async price(): Promise<LlmPrice> {
    return { input: 1e-6, output: 1e-6 };
  }

  async balance(): Promise<number | null> {
    return this.options.balance === undefined ? 10 : this.options.balance;
  }

  async *stream(
    messages: readonly LlmMessage[],
    options: LlmStreamOptions,
  ): AsyncIterable<LlmChunk> {
    this.lastMessages = messages;
    this.calls += 1;
    const words = (this.options.answer ?? DEFAULT_ANSWER).split(/(?<= )/);
    for (const word of words) {
      if (options.signal.aborted) return;
      if (this.options.tokenDelayMs)
        await new Promise((resolve) =>
          setTimeout(resolve, this.options.tokenDelayMs),
        );
      this.yielded += 1;
      yield { type: 'token', text: word };
    }
    const inputTokens = Math.ceil(
      messages.reduce((sum, m) => sum + m.content.length, 0) / 4,
    );
    yield {
      type: 'usage',
      usage: {
        inputTokens,
        outputTokens: words.length,
        usd: (inputTokens + words.length) * 1e-6,
      },
    };
  }
}
