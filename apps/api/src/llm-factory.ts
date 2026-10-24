import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OpenRouterAdapter } from './adapters/openrouter-adapter.js';
import { StubLlmAdapter } from './adapters/stub-llm-adapter.js';
import type { AppConfig } from './config.js';
import type { LlmPort } from './ports/llm.js';

export const FALLBACK_MODEL = 'deepseek/deepseek-v4-flash';

/** The kb vault's generation model (kb.toml [generation] model), reused for answers. */
export async function vaultGenerationModel(
  vaultRoot: string,
): Promise<string | null> {
  const toml = await readFile(join(vaultRoot, 'kb.toml'), 'utf8').catch(
    () => '',
  );
  const section =
    toml.split(/^\[/m).find((block) => block.startsWith('generation]')) ?? '';
  return /^\s*model\s*=\s*"([^"]+)"/m.exec(section)?.[1] ?? null;
}

/** Composition of the AI provider from config (ADR 0004; more providers in KBC-007). */
export async function createLlm(config: AppConfig): Promise<LlmPort> {
  if (config.KB_CHAT_LLM === 'stub') return new StubLlmAdapter();
  const model =
    config.KB_CHAT_MODEL ??
    (await vaultGenerationModel(config.KB_VAULT)) ??
    FALLBACK_MODEL;
  return new OpenRouterAdapter({ apiKey: config.OPENROUTER_API_KEY, model });
}
