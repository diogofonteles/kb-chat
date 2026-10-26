import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  MODEL_ALLOWLISTS,
  type AiProvider,
  type AiTestRequest,
  type AiTestResult,
  type ProviderInfo,
  type ProviderList,
  modelProfileOf,
  type ModelProfile,
  type ResearchProfile,
} from '@kb-chat/contracts';
import { AnthropicAdapter } from '../adapters/anthropic-adapter.js';
import { ClaudeCliRunner } from '../adapters/claude-cli-runner.js';
import { CodexCliRunner } from '../adapters/codex-cli-runner.js';
import { DisabledLlm } from '../adapters/disabled-llm.js';
import type { SubscriptionPrompt } from '../adapters/subscription-prompt.js';
import { OpenAiAdapter } from '../adapters/openai-adapter.js';
import { OpenRouterAdapter } from '../adapters/openrouter-adapter.js';
import { StubLlmAdapter } from '../adapters/stub-llm-adapter.js';
import type { AppConfig } from '../config.js';
import type { McpTurnRegistry } from '../mcp/mcp-turns.js';
import type {
  ProviderCatalog,
  SettingsService,
} from '../modules/settings/index.js';
import type { LlmPort } from '../ports/llm.js';
import type { AgentLlmPort } from '../ports/llm.js';
import type {
  Escalation,
  PerTokenRunnerFactory,
  ResearchRunnerPort,
} from '../ports/research-runner.js';
import type { ResearchToolsFactory } from '../ports/research-tools.js';
import { researchBudgets } from '../modules/research/index.js';
import { findExecutable } from './command-locator.js';
import { NO_TOOLS, testConnection } from './connection-test.js';
import { DisabledResearchRunner, isAgentLlm } from './dynamic-ports.js';
import {
  PROVIDERS,
  defaultProvider,
  isKeyProvider,
  type ResolvedProvider,
} from './provider-catalog.js';

export interface ProviderRegistryOptions {
  readonly config: AppConfig;
  readonly settings: SettingsService;
  readonly turns: McpTurnRegistry;
  /** Where this API listens, for the subscription CLIs' MCP connection. */
  readonly apiBaseUrl: string;
  /** PATH for the CLI lookup and the environment the CLIs inherit. */
  readonly env: NodeJS.ProcessEnv;
  /** HTTP for the per-token adapters (a fake in tests and E2E). */
  readonly fetch?: typeof fetch;
  /** The research tools (KBC-008); without them subscriptions cannot research. */
  readonly tools?: ResearchToolsFactory;
  /** The in-API tool loop (KBC-008) over a per-token model. */
  readonly perTokenRunner?: PerTokenRunnerFactory;
  /** The research rules for a topic and profile, for the subscription CLIs; default: the module's, by slug. */
  readonly systemPrompt?: SubscriptionPrompt;
  /**
   * The owner's principal (KBC-010): only it may use the subscriptions (personal, KBC-007
   * BR-6) and the keys of the server's environment; guests bring their own key.
   */
  readonly ownerPrincipal?: string;
}

const isSubscription = (provider: ResolvedProvider): boolean =>
  provider === 'claude-subscription' || provider === 'chatgpt-subscription';

/** How one runner is built: for whom, with which tools, and the deep model to escalate to. */
interface RunnerBuild {
  readonly principal: string;
  readonly tools?: ResearchToolsFactory;
  /** A fast runner's deep model (null: the CLI's own); undefined: no escalation. */
  readonly deepModel?: string | null;
}

/** A provider resolved for one principal: which one, its model and its key. */
export interface ProviderChoice {
  readonly provider: ResolvedProvider;
  readonly model: string | undefined;
  readonly key: string | undefined;
}

interface ChoiceOverride {
  readonly provider?: ResolvedProvider;
  readonly model?: string;
  readonly key?: string;
  /** Whose model: the fast one (default) or the deep one (KBC-011). */
  readonly profile?: ResearchProfile;
}

/** A key's fingerprint for cache ids: the key itself is kept only by the adapter. */
const fingerprint = (key: string | undefined): string =>
  key ? createHash('sha256').update(key).digest('base64url').slice(0, 16) : '';

export const choiceId = (
  kind: string,
  principal: string,
  c: ProviderChoice,
): string =>
  [kind, principal, c.provider, c.model ?? '', fingerprint(c.key)].join('|');

/**
 * The AI provider of each principal (KBC-007, ADR 0007): their Settings first, then the
 * environment (BR-4). Every call resolves again, so switching applies on the next request
 * (FR-5); built adapters are reused while the choice stays the same (price/balance caches).
 */
export class ProviderRegistry implements ProviderCatalog {
  private readonly cache = new Map<string, LlmPort | ResearchRunnerPort>();
  /** Whether `claude` was on PATH at the last lookup (boot, then every provider list). */
  private claudeOnPath = false;

  constructor(private readonly options: ProviderRegistryOptions) {}

  /** Looks `claude` up again; the default provider depends on it (BR-4). */
  async refreshCliLookup(): Promise<void> {
    this.claudeOnPath = (await this.locateCli('claude-subscription')) !== null;
  }

  /** The provider answering now for the principal. */
  active(principal: string): ResolvedProvider {
    const saved = this.options.settings.snapshot(principal)?.ai.provider;
    if (this.isOwner(principal))
      return saved ?? defaultProvider(this.options.config, this.claudeOnPath);
    if (saved && !isSubscription(saved)) return saved;
    // A guest has no subscription and no environment key: search only, or the test stub.
    return this.options.config.KB_CHAT_LLM === 'stub' ? 'stub' : 'none';
  }

  private isOwner(principal: string): boolean {
    return principal === (this.options.ownerPrincipal ?? 'owner');
  }

  /** Daily cap in US$ for per-token providers (Settings, else KB_CHAT_DAILY_CAP_USD). */
  dailyCapUsd(principal: string): number {
    return this.options.settings.dailyCapUsd(principal);
  }

  choice(principal: string, override: ChoiceOverride = {}): ProviderChoice {
    const provider = override.provider ?? this.active(principal);
    const profile = modelProfileOf(override.profile ?? 'fast');
    return {
      provider,
      model:
        override.model ??
        this.savedModel(principal, provider, profile) ??
        this.defaultModel(provider, profile),
      key: override.key ?? this.key(principal, provider),
    };
  }

  llm(principal: string): LlmPort {
    const choice = this.choice(principal);
    return this.cached(choiceId('llm', principal, choice), () =>
      this.buildLlm(choice),
    ) as LlmPort;
  }

  /**
   * The runner of a research turn: the provider's model for the profile (KBC-011). A fast
   * runner also gets the deep model, to escalate to when the fast pass is not enough.
   */
  researchRunner(
    principal: string,
    profile: ResearchProfile = 'fast',
  ): ResearchRunnerPort {
    const choice = this.choice(principal, { profile });
    const deepModel =
      profile === 'fast'
        ? (this.choice(principal, { profile: 'deep' }).model ?? null)
        : undefined;
    // One cached runner per profile (and deep model), so asking fast then deep keeps both.
    const kind = `runner-${profile}>${deepModel ?? ''}`;
    return this.cached(choiceId(kind, principal, choice), () =>
      this.buildRunner(choice, { principal, deepModel }),
    ) as ResearchRunnerPort;
  }

  /** Settings' "Aprofundar automaticamente" (on unless turned off). */
  autoDeepen(principal: string): boolean {
    return (
      this.options.settings.snapshot(principal)?.preferences.autoDeepen ?? true
    );
  }

  async list(principal: string): Promise<ProviderList> {
    await this.options.settings.load(principal);
    await this.refreshCliLookup();
    const ids = Object.keys(PROVIDERS) as AiProvider[];
    const items = await Promise.all(ids.map((id) => this.info(principal, id)));
    return { items, active: this.active(principal) };
  }

  async test(
    principal: string,
    request: AiTestRequest,
    signal: AbortSignal,
  ): Promise<AiTestResult> {
    await this.options.settings.load(principal);
    const choice = this.choice(principal, request);
    return testConnection({
      choice,
      signal,
      locate: () => this.locateCli(request.provider),
      llm: () => this.buildLlm(choice),
      runner: () =>
        this.buildRunner(choice, { principal, tools: () => NO_TOOLS }),
    });
  }

  private buildLlm({ provider, model, key }: ProviderChoice): LlmPort {
    const fetch = this.options.fetch;
    const options = { apiKey: key, model: model ?? '', fetch };
    if (provider === 'stub') return new StubLlmAdapter();
    if (provider === 'openrouter')
      return new OpenRouterAdapter({
        ...options,
        reasoning: this.options.config.KB_CHAT_REASONING,
      });
    if (provider === 'anthropic') return new AnthropicAdapter(options);
    if (provider === 'openai') return new OpenAiAdapter(options);
    return new DisabledLlm();
  }

  private buildRunner(
    choice: ProviderChoice,
    build: RunnerBuild,
  ): ResearchRunnerPort {
    const { principal } = build;
    if (isSubscription(choice.provider) && !this.isOwner(principal))
      return new DisabledResearchRunner();
    if (choice.provider === 'claude-subscription')
      return new ClaudeCliRunner(this.cliOptions('claude', choice, build));
    if (choice.provider === 'chatgpt-subscription')
      return this.options.config.KB_CHAT_CODEX
        ? new CodexCliRunner(this.cliOptions('codex', choice, build))
        : new DisabledResearchRunner();
    const llm = this.buildLlm(choice);
    const loop = this.options.perTokenRunner;
    if (!loop || !isAgentLlm(llm)) return new DisabledResearchRunner();
    const scope = { principal, dailyCapUsd: () => this.dailyCapUsd(principal) };
    return loop(llm, scope, this.perTokenEscalation(choice, build));
  }

  private perTokenEscalation(
    choice: ProviderChoice,
    { principal, deepModel }: RunnerBuild,
  ): Escalation<AgentLlmPort> | undefined {
    if (deepModel === undefined) return undefined;
    const deep = this.buildLlm({ ...choice, model: deepModel ?? undefined });
    if (!isAgentLlm(deep)) return undefined;
    return { deep, enabled: () => this.autoDeepen(principal) };
  }

  private cliOptions(
    cli: 'claude' | 'codex',
    choice: ProviderChoice,
    { principal, deepModel, tools = this.options.tools }: RunnerBuild,
  ) {
    const { config } = this.options;
    const escalation: Escalation<string | undefined> | undefined =
      deepModel === undefined
        ? undefined
        : {
            deep: deepModel ?? undefined,
            enabled: () => this.autoDeepen(principal),
          };
    return {
      escalation,
      budgets: researchBudgets({
        steps: config.KB_CHAT_EXHAUSTIVE_STEPS,
        outputTokens: config.KB_CHAT_EXHAUSTIVE_OUTPUT_TOKENS,
      }),
      bin: cli === 'claude' ? config.CLAUDE_BIN : config.CODEX_BIN,
      model: choice.model,
      apiBaseUrl: this.options.apiBaseUrl,
      turns: this.options.turns,
      workDir: join(config.KB_CHAT_STATE_DIR, 'cli', cli),
      env: this.options.env,
      tools,
      systemPrompt: this.options.systemPrompt,
    };
  }

  /** One live choice per kind and principal: a replaced provider (and key) leaves memory. */
  private cached(
    id: string,
    build: () => LlmPort | ResearchRunnerPort,
  ): LlmPort | ResearchRunnerPort {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const owner = id.split('|').slice(0, 2).join('|');
    for (const key of this.cache.keys())
      if (key.startsWith(`${owner}|`)) this.cache.delete(key);
    const built = build();
    this.cache.set(id, built);
    return built;
  }

  private savedModel(
    principal: string,
    provider: ResolvedProvider,
    profile: ModelProfile,
  ): string | undefined {
    if (provider === 'stub' || provider === 'none') return undefined;
    const models = this.options.settings.snapshot(principal)?.ai.models;
    return models?.[provider]?.[profile];
  }

  private defaultModel(
    provider: ResolvedProvider,
    profile: ModelProfile,
  ): string | undefined {
    if (provider === 'stub') return 'stub/model';
    const defaults = PROVIDERS[provider].defaultModels(this.options.config);
    return defaults[profile] ?? undefined;
  }

  private key(
    principal: string,
    provider: ResolvedProvider,
  ): string | undefined {
    if (provider === 'stub' || !isKeyProvider(provider)) return undefined;
    const env = PROVIDERS[provider].keyEnv;
    const own = this.options.settings.key(principal, provider);
    if (own || !this.isOwner(principal)) return own;
    return env ? this.options.config[env] : undefined;
  }

  private keySource(
    principal: string,
    provider: AiProvider,
  ): ProviderInfo['keySource'] {
    if (!isKeyProvider(provider)) return null;
    if (this.options.settings.key(principal, provider)) return 'settings';
    return this.key(principal, provider) ? 'env' : null;
  }

  private locateCli(provider: AiProvider): Promise<string | null> {
    const bin = PROVIDERS[provider].cliBin;
    if (!bin) return Promise.resolve(null);
    return findExecutable(
      this.options.config[bin],
      this.options.env.PATH ?? '',
    );
  }

  private unavailableReason(
    principal: string,
    id: AiProvider,
    cliFound: boolean,
  ): ProviderInfo['reason'] {
    if (isSubscription(id) && !this.isOwner(principal)) return 'owner-only';
    if (PROVIDERS[id].cliBin && !cliFound) return 'cli-missing';
    if (id === 'chatgpt-subscription' && !this.options.config.KB_CHAT_CODEX)
      return 'not-enabled';
    if (isKeyProvider(id) && this.keySource(principal, id) === null)
      return 'key-missing';
    return null;
  }

  private async info(principal: string, id: AiProvider): Promise<ProviderInfo> {
    const cliFound = (await this.locateCli(id)) !== null;
    const reason = this.unavailableReason(principal, id, cliFound);
    const defaults = PROVIDERS[id].defaultModels(this.options.config);
    const models = [defaults.fast, defaults.deep, ...PROVIDERS[id].models];
    return {
      id,
      billing: PROVIDERS[id].billing,
      available: reason === null,
      reason,
      keySource: this.keySource(principal, id),
      defaultModels: defaults,
      models: [
        ...new Set(models.filter((m): m is string => typeof m === 'string')),
      ],
      freeModel: id === 'none' || !MODEL_ALLOWLISTS[id],
    };
  }
}
