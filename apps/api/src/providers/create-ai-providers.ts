import type { SubscriptionPrompt } from '../adapters/subscription-prompt.js';
import type { AppConfig } from '../config.js';
import { McpTurnRegistry } from '../mcp/mcp-turns.js';
import { SettingsService } from '../modules/settings/index.js';
import type { PerTokenRunnerFactory } from '../ports/research-runner.js';
import type { ResearchToolsFactory } from '../ports/research-tools.js';
import type { SettingsStorePort } from '../ports/settings-store.js';
import type { SpendLedgerPort } from '../ports/spend-ledger.js';
import type { HouseAi } from '../house-ai-factory.js';
import type { Viewer } from '../modules/auth/index.js';
import { AppAiPlan, type LendableSubscription } from './app-ai-plan.js';
import { DisabledLlm } from '../adapters/disabled-llm.js';
import { DisabledResearchRunner, DynamicLlm } from './dynamic-ports.js';
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
  /** The research tools of a turn (KBC-008), served to the subscription CLIs over MCP. */
  readonly tools?: ResearchToolsFactory;
  /** The in-API tool loop over a per-token model (KBC-008). */
  readonly perTokenRunner?: PerTokenRunnerFactory;
  /** The research rules for a topic and profile, for the subscription CLIs (the module's prompt). */
  readonly systemPrompt?: SubscriptionPrompt;
  /** A sub-researcher's rules for a topic (ADR 0014). */
  readonly subAgentPrompt?: (topic: string) => string;
  readonly warn?: (message: string) => void;
  /** The turns' MCP registry when the caller serves it itself (agent-eval); default: a new one. */
  readonly turns?: McpTurnRegistry;
  /** Where the CLIs reach the MCP endpoints; default: this API on PORT. */
  readonly apiBaseUrl?: string;
  /** Only this principal uses subscriptions and environment keys (KBC-010); default `owner`. */
  readonly ownerPrincipal?: string;
  /** The house plan and who a principal is (KBC-022); without them no app AI is lent. */
  readonly house?: HouseAi;
  readonly personOf?: (principal: string) => Viewer | null;
  /** The own spend ledger: today's spend bounds one's own paid fallback (KBC-023). */
  readonly ledger?: SpendLedgerPort;
  /**
   * The owner's subscription as lent to people (KBC-024); default: the registry's, from the
   * owner's CLI. The E2E server passes one over the stub, as it has no CLI.
   */
  readonly claudeSubscription?: LendableSubscription;
}

/** Settings, the provider registry and the per-request ports built on them (ADR 0007). */
export interface AiProviders {
  readonly settings: SettingsService;
  readonly registry: ProviderRegistry;
  readonly turns: McpTurnRegistry;
  /** The current provider's model, resolved on every call (FR-5). */
  readonly llm: DynamicLlm;
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

/** Today's own spend of a principal, from the ledger when there is one. */
const spentTodayOf = (ledger: SpendLedgerPort | undefined) =>
  ledger ? (principal: string) => ledger.spentToday(principal) : undefined;

/** The app-owned AIs (KBC-022, KBC-024) over the house plan, when the caller gave one. */
function appAiOf(
  options: AiProvidersOptions,
  claudeSubscription: LendableSubscription,
): AppAiPlan | undefined {
  const { house, personOf } = options;
  if (!house || !personOf) return undefined;
  return new AppAiPlan({
    claudeSubscription,
    house: house.service,
    catalog: house.catalog,
    quota: house.quota,
    houseSpend: house.spend,
    personOf,
    perTokenRunner: options.perTokenRunner,
    fetch: house.fetch ?? options.fetch,
    warn: options.warn,
  });
}

export async function createAiProviders(
  options: AiProvidersOptions,
): Promise<AiProviders> {
  const { config } = options;
  const settings = await loadSettings(options);
  const turns = options.turns ?? new McpTurnRegistry();
  // The plan is built before the registry, which builds the lent subscription: bound late.
  const lazy: { registry?: ProviderRegistry } = {};
  const lent = (): LendableSubscription | undefined =>
    options.claudeSubscription ?? lazy.registry?.lendableSubscription();
  const claudeSubscription: LendableSubscription = {
    available: () => lent()?.available() ?? false,
    llm: () => lent()?.llm() ?? new DisabledLlm(),
    runner: (profile) =>
      lent()?.runner(profile) ?? new DisabledResearchRunner(),
  };
  const registry = new ProviderRegistry({
    config,
    settings,
    turns,
    apiBaseUrl: options.apiBaseUrl ?? `http://127.0.0.1:${config.PORT}`,
    env: options.env,
    fetch: options.fetch,
    tools: options.tools,
    perTokenRunner: options.perTokenRunner,
    systemPrompt: options.systemPrompt,
    subAgentPrompt: options.subAgentPrompt,
    ownerPrincipal: options.ownerPrincipal,
    appAi: appAiOf(options, claudeSubscription),
    freeModels: options.house?.catalog,
    spentToday: spentTodayOf(options.ledger),
  });
  lazy.registry = registry;
  await registry.refreshCliLookup();
  return {
    settings,
    registry,
    turns,
    llm: new DynamicLlm(() => registry.llm(options.principal)),
  };
}
