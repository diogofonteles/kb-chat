import { join } from 'node:path';
import type {
  AiProvider,
  AiTestRequest,
  AiTestResult,
  ProviderInfo,
  ProviderList,
} from '@kb-chat/contracts';
import { AnthropicAdapter } from '../adapters/anthropic-adapter.js';
import { ClaudeCliRunner } from '../adapters/claude-cli-runner.js';
import { CodexCliRunner } from '../adapters/codex-cli-runner.js';
import { DisabledLlm } from '../adapters/disabled-llm.js';
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
import type {
  PerTokenRunnerFactory,
  ResearchRunnerPort,
} from '../ports/research-runner.js';
import type { ResearchToolsFactory } from '../ports/research-tools.js';
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
  /** The research rules for a topic, for the subscription CLIs; default: the module's, by slug. */
  readonly systemPrompt?: (topic: string) => string;
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
}

const choiceId = (kind: string, principal: string, c: ProviderChoice) =>
  [kind, principal, c.provider, c.model ?? '', c.key ?? ''].join('|');

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
    return (
      this.options.settings.snapshot(principal)?.ai.provider ??
      defaultProvider(this.options.config, this.claudeOnPath)
    );
  }

  /** Daily cap in US$ for per-token providers (Settings, else KB_CHAT_DAILY_CAP_USD). */
  dailyCapUsd(principal: string): number {
    return this.options.settings.dailyCapUsd(principal);
  }

  choice(principal: string, override: ChoiceOverride = {}): ProviderChoice {
    const provider = override.provider ?? this.active(principal);
    const saved = this.options.settings.snapshot(principal)?.ai;
    const savedModel = saved?.provider === provider ? saved.model : undefined;
    return {
      provider,
      model: override.model ?? savedModel ?? this.defaultModel(provider),
      key: override.key ?? this.key(principal, provider),
    };
  }

  llm(principal: string): LlmPort {
    const choice = this.choice(principal);
    return this.cached(choiceId('llm', principal, choice), () =>
      this.buildLlm(choice),
    ) as LlmPort;
  }

  researchRunner(principal: string): ResearchRunnerPort {
    const choice = this.choice(principal);
    return this.cached(choiceId('runner', principal, choice), () =>
      this.buildRunner(choice, principal),
    ) as ResearchRunnerPort;
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
      runner: () => this.buildRunner(choice, principal, () => NO_TOOLS),
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
    principal: string,
    tools = this.options.tools,
  ): ResearchRunnerPort {
    if (choice.provider === 'claude-subscription')
      return new ClaudeCliRunner(this.cliOptions('claude', choice, tools));
    if (choice.provider === 'chatgpt-subscription')
      return this.options.config.KB_CHAT_CODEX
        ? new CodexCliRunner(this.cliOptions('codex', choice, tools))
        : new DisabledResearchRunner();
    const llm = this.buildLlm(choice);
    const loop = this.options.perTokenRunner;
    if (!loop || !isAgentLlm(llm)) return new DisabledResearchRunner();
    return loop(llm, {
      principal,
      dailyCapUsd: () => this.dailyCapUsd(principal),
    });
  }

  private cliOptions(
    cli: 'claude' | 'codex',
    choice: ProviderChoice,
    tools: ResearchToolsFactory | undefined,
  ) {
    const { config } = this.options;
    return {
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

  private defaultModel(provider: ResolvedProvider): string | undefined {
    if (provider === 'stub') return 'stub/model';
    return PROVIDERS[provider].defaultModel(this.options.config) ?? undefined;
  }

  private key(
    principal: string,
    provider: ResolvedProvider,
  ): string | undefined {
    if (provider === 'stub' || !isKeyProvider(provider)) return undefined;
    const env = PROVIDERS[provider].keyEnv;
    return (
      this.options.settings.key(principal, provider) ??
      (env ? this.options.config[env] : undefined)
    );
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
    const defaultModel = this.defaultModel(id);
    const models = [defaultModel, ...PROVIDERS[id].models].filter(
      (model): model is string => Boolean(model),
    );
    return {
      id,
      billing: PROVIDERS[id].billing,
      available: reason === null,
      reason,
      keySource: this.keySource(principal, id),
      defaultModel: defaultModel ?? null,
      models: [...new Set(models)],
    };
  }
}
