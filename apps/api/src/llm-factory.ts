import { OpenRouterAdapter } from './adapters/openrouter-adapter.js';
import { StubLlmAdapter } from './adapters/stub-llm-adapter.js';
import type { AppConfig } from './config.js';
import type { AgentLlmPort } from './ports/llm.js';

/** Research agent default (ADR 0006): tool calling at about US$ 0.23 per million input tokens. */
export const DEFAULT_MODEL = 'deepseek/deepseek-v4-pro';

/** Composition of the AI provider from config (ADR 0006; more providers in KBC-007). */
export function createLlm(config: AppConfig): AgentLlmPort {
  if (config.KB_CHAT_LLM === 'stub') return new StubLlmAdapter();
  return new OpenRouterAdapter({
    apiKey: config.OPENROUTER_API_KEY,
    model: config.KB_CHAT_MODEL ?? DEFAULT_MODEL,
    reasoning: config.KB_CHAT_REASONING,
  });
}
