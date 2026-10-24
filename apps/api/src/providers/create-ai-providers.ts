import type { AppConfig } from '../config.js';
import { vaultGenerationModel } from '../llm-factory.js';
import { McpTurnRegistry } from '../mcp/mcp-turns.js';
import { SettingsService } from '../modules/settings/index.js';
import type { AgentLlmPort } from '../ports/llm.js';
import type { ResearchRunnerPort } from '../ports/research-runner.js';
import type { ResearchToolsFactory } from '../ports/research-tools.js';
import type { SettingsStorePort } from '../ports/settings-store.js';
import { DynamicLlm, DynamicResearchRunner } from './dynamic-ports.js';
import { ProviderRegistry } from './provider-registry.js';

export interface AiProvidersOptions {
  readonly config: AppConfig;
  readonly store: SettingsStorePort;
  /**
   * The principal the per-request ports answer for: the owner in release 1 (ADR 0005).
   * With ADR 0008's login, routes ask the registry with the signed-in principal instead.
   */
  readonly principal: string;
  /** PATH for the CLI lookup and what the CLIs inherit (process.env in main). */
  readonly env: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  readonly tools?: ResearchToolsFactory;
  readonly perTokenRunner?: (llm: AgentLlmPort) => ResearchRunnerPort;
  readonly warn?: (message: string) => void;
}

/** Settings, the provider registry and the per-request ports built on them (ADR 0007). */
export interface AiProviders {
  readonly settings: SettingsService;
  readonly registry: ProviderRegistry;
  readonly turns: McpTurnRegistry;
  /** The current provider's model, resolved on every call (FR-5). */
  readonly llm: DynamicLlm;
  /** The current provider's research runner, resolved per turn (FR-5). */
  readonly research: DynamicResearchRunner;
}

async function loadSettings(
  options: AiProvidersOptions,
): Promise<SettingsService> {
  const settings = new SettingsService({
    store: options.store,
    defaultDailyCapUsd: options.config.KB_CHAT_DAILY_CAP_USD,
    warn: options.warn,
  });
  await settings.load(options.principal);
  return settings;
}

export async function createAiProviders(
  options: AiProvidersOptions,
): Promise<AiProviders> {
  const { config } = options;
  const settings = await loadSettings(options);
  const turns = new McpTurnRegistry();
  const registry = new ProviderRegistry({
    config,
    settings,
    vaultModel: await vaultGenerationModel(config.KB_VAULT),
    turns,
    apiBaseUrl: `http://127.0.0.1:${config.PORT}`,
    env: options.env,
    fetch: options.fetch,
    tools: options.tools,
    perTokenRunner: options.perTokenRunner,
  });
  await registry.refreshCliLookup();
  return {
    settings,
    registry,
    turns,
    llm: new DynamicLlm(() => registry.llm(options.principal)),
    research: new DynamicResearchRunner(() =>
      registry.researchRunner(options.principal),
    ),
  };
}
