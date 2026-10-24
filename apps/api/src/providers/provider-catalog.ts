import type {
  AiProvider,
  KeyProvider,
  ProviderBilling,
} from '@kb-chat/contracts';
import {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_PRICES,
} from '../adapters/anthropic-adapter.js';
import {
  OPENAI_DEFAULT_MODEL,
  OPENAI_PRICES,
} from '../adapters/openai-adapter.js';
import type { AppConfig } from '../config.js';
import { FALLBACK_MODEL } from '../llm-factory.js';

/** A provider as chosen in Settings, plus the deterministic stub of tests and E2E. */
export type ResolvedProvider = AiProvider | 'stub';

export interface ProviderDescriptor {
  readonly billing: ProviderBilling;
  /** The env variable whose key is the default (BR-4). */
  readonly keyEnv?:
    'OPENROUTER_API_KEY' | 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY';
  /** The official CLI of a subscription. */
  readonly cliBin?: 'CLAUDE_BIN' | 'CODEX_BIN';
  /** The model used when Settings choose none; null lets the CLI decide. */
  readonly defaultModel: (
    config: AppConfig,
    vaultModel: string | null,
  ) => string | null;
  readonly models: readonly string[];
}

const openRouterDefault = (config: AppConfig, vaultModel: string | null) =>
  config.KB_CHAT_MODEL ?? vaultModel ?? FALLBACK_MODEL;

export const PROVIDERS: Readonly<Record<AiProvider, ProviderDescriptor>> = {
  openrouter: {
    billing: 'per-token',
    keyEnv: 'OPENROUTER_API_KEY',
    defaultModel: openRouterDefault,
    models: ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash'],
  },
  anthropic: {
    billing: 'per-token',
    keyEnv: 'ANTHROPIC_API_KEY',
    defaultModel: () => ANTHROPIC_DEFAULT_MODEL,
    models: Object.keys(ANTHROPIC_PRICES),
  },
  openai: {
    billing: 'per-token',
    keyEnv: 'OPENAI_API_KEY',
    defaultModel: () => OPENAI_DEFAULT_MODEL,
    models: Object.keys(OPENAI_PRICES),
  },
  'claude-subscription': {
    billing: 'subscription',
    cliBin: 'CLAUDE_BIN',
    defaultModel: () => null,
    models: ['opus', 'sonnet', 'fable', 'haiku'],
  },
  'chatgpt-subscription': {
    billing: 'subscription',
    cliBin: 'CODEX_BIN',
    defaultModel: () => null,
    models: ['gpt-5.5', 'gpt-5.4'],
  },
  none: { billing: 'none', defaultModel: () => null, models: [] },
};

export const isKeyProvider = (provider: AiProvider): provider is KeyProvider =>
  PROVIDERS[provider].keyEnv !== undefined;

/**
 * With no provider chosen, the default (KBC-007 BR-4, owner's decision 2026-10-24):
 * the stub when configured (tests, E2E), then the Claude subscription when `claude` is on
 * PATH, then the env keys as before KBC-007, else search only.
 */
export function defaultProvider(
  config: AppConfig,
  claudeOnPath: boolean,
): ResolvedProvider {
  if (config.KB_CHAT_LLM === 'stub') return 'stub';
  if (claudeOnPath) return 'claude-subscription';
  if (config.OPENROUTER_API_KEY) return 'openrouter';
  if (config.ANTHROPIC_API_KEY) return 'anthropic';
  if (config.OPENAI_API_KEY) return 'openai';
  return 'none';
}
