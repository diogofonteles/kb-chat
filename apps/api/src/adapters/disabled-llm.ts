import type { LlmChunk, LlmPort, LlmPrice } from '../ports/llm.js';

/** No AI provider: searching works, answers are refused with LLM_NOT_CONFIGURED. */
export class DisabledLlm implements LlmPort {
  readonly model = 'none';
  readonly billing = 'per-token' as const;

  configured(): boolean {
    return false;
  }

  async price(): Promise<LlmPrice> {
    return { input: 0, output: 0 };
  }

  async balance(): Promise<number | null> {
    return null;
  }

  // eslint-disable-next-line require-yield -- never called: configured() is false.
  async *stream(): AsyncIterable<LlmChunk> {
    throw new Error('No AI provider configured');
  }
}
