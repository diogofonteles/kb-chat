import {
  KEY_PROVIDERS,
  MODEL_ALLOWLISTS,
  type AiProvider,
  type KeyProvider,
  type ProviderBilling,
  type ModelProfile,
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
import {
  GEMINI_DEEP_MODEL,
  GEMINI_FAST_MODEL,
  GEMINI_PRICES,
} from '../adapters/gemini-adapter.js';

/** A provider as chosen in Settings, plus the deterministic stub of tests and E2E. */
export type ResolvedProvider = AiProvider | 'stub';

export interface ProviderDescriptor {
  readonly billing: ProviderBilling;
  /** The env variable whose key is the default (BR-4). */
  readonly keyEnv?:
    'OPENROUTER_API_KEY' | 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY';
  /** The official CLI of a subscription. */
  readonly cliBin?: 'CLAUDE_BIN' | 'CODEX_BIN';
  /** The model of each profile when Settings choose none; null lets the CLI decide. */
  readonly defaultModels: (config: AppConfig) => ProfileDefaults;
  readonly models: readonly string[];
}

export type ProfileDefaults = Readonly<Record<ModelProfile, string | null>>;

/** Research agent default (ADR 0006): tool calling at about US$ 0.23 per million input tokens. */
export const OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-v4-pro';
/** The fast profile's OpenRouter default (KBC-011). */
export const OPENROUTER_FAST_MODEL = 'deepseek/deepseek-v4-flash';

/**
 * The research agent needs tool calling: ADR 0006's defaults, not the vault's kb.toml
 * model. KB_CHAT_MODEL, the one model of the environment, sets both profiles.
 */
const openRouterDefaults = (config: AppConfig): ProfileDefaults => ({
  fast: config.KB_CHAT_MODEL ?? OPENROUTER_FAST_MODEL,
  deep: config.KB_CHAT_MODEL ?? OPENROUTER_DEFAULT_MODEL,
});

const fixed =
  (fast: string | null, deep: string | null) => (): ProfileDefaults => ({
    fast,
    deep,
  });

const CLAUDE_MODELS = MODEL_ALLOWLISTS['claude-subscription'] ?? [];
const CODEX_MODELS = MODEL_ALLOWLISTS['chatgpt-subscription'] ?? [];

export const PROVIDERS: Readonly<Record<AiProvider, ProviderDescriptor>> = {
  // The AI a master lends (KBC-022): resolved by the app AI plan, not by a key or a model.
  app: { billing: 'free', defaultModels: fixed(null, null), models: [] },
  openrouter: {
    billing: 'per-token',
    keyEnv: 'OPENROUTER_API_KEY',
    defaultModels: openRouterDefaults,
    models: [OPENROUTER_FAST_MODEL, OPENROUTER_DEFAULT_MODEL],
  },
  anthropic: {
    billing: 'per-token',
    keyEnv: 'ANTHROPIC_API_KEY',
    defaultModels: fixed('claude-sonnet-5-5', ANTHROPIC_DEFAULT_MODEL),
    models: Object.keys(ANTHROPIC_PRICES),
  },
  openai: {
    billing: 'per-token',
    keyEnv: 'OPENAI_API_KEY',
    // The existing default for both: the dearer GPT models stay a choice (KBC-011).
    defaultModels: fixed(OPENAI_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL),
    models: Object.keys(OPENAI_PRICES),
  },
  'claude-subscription': {
    billing: 'subscription',
    cliBin: 'CLAUDE_BIN',
    // Sonnet answers in about half the time of Opus (owner's decision, KBC-011).
    defaultModels: fixed('sonnet', 'opus'),
    models: CLAUDE_MODELS,
  },
  'chatgpt-subscription': {
    billing: 'subscription',
    cliBin: 'CODEX_BIN',
    defaultModels: fixed(null, null),
    models: CODEX_MODELS,
  },
  // Google AI Studio key (KBC-023, ADR 0018): the free tier by default.
  gemini: {
    billing: 'per-token',
    defaultModels: fixed(GEMINI_FAST_MODEL, GEMINI_DEEP_MODEL),
    models: Object.keys(GEMINI_PRICES),
  },
  none: { billing: 'none', defaultModels: fixed(null, null), models: [] },
};

export const isKeyProvider = (provider: AiProvider): provider is KeyProvider =>
  KEY_PROVIDERS.some((id) => id === provider);

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
