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
import type { LentSubscription } from '@kb-chat/contracts';
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
   * The owner's subscriptions as lent to people (KBC-024, KBC-027); default: the registry's,
   * from the owner's CLIs. The E2E server passes them over the stub, as it has no CLI.
   */
  readonly subscriptions?: Partial<
    Record<LentSubscription, LendableSubscription>
  >;
}

/** Settings, the provider registry and the per-request ports built on them (ADR 0007). */
export interface AiProviders {
  readonly settings: SettingsService;
  readonly registry: ProviderRegistry;
  readonly turns: McpTurnRegistry;
  /** The current provider's model, resolved on every call (FR-5). */
  readonly llm: DynamicLlm;
  /** The owner's subscriptions as they are lent to people (KBC-024, KBC-027). */
  readonly lent: Record<LentSubscription, LendableSubscription>;
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
  subscriptions: Record<LentSubscription, LendableSubscription>,
): AppAiPlan | undefined {
  const { house, personOf } = options;
  if (!house || !personOf) return undefined;
  return new AppAiPlan({
    subscriptions,
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

/**
 * The lent subscription for the plan, built before the registry that makes it: the caller's,
 * else the registry's once it exists (bound late).
 */
function lateSubscription(
  options: AiProvidersOptions,
  lazy: { registry?: ProviderRegistry },
  kind: LentSubscription,
): LendableSubscription {
  const lent = (): LendableSubscription | undefined =>
    options.subscriptions?.[kind] ?? lazy.registry?.lendable(kind);
  return {
    available: () => lent()?.available() ?? false,
    llm: () => lent()?.llm() ?? new DisabledLlm(),
    runner: (profile) =>
      lent()?.runner(profile) ?? new DisabledResearchRunner(),
    failed: (code) => lent()?.failed(code),
  };
}

/** Both of the owner's subscriptions, bound late to the registry. */
const lateSubscriptions = (
  options: AiProvidersOptions,
  lazy: { registry?: ProviderRegistry },
): Record<LentSubscription, LendableSubscription> => ({
  'claude-subscription': lateSubscription(options, lazy, 'claude-subscription'),
  'chatgpt-subscription': lateSubscription(
    options,
    lazy,
    'chatgpt-subscription',
  ),
});

/** The registry over the settings, the turns and the app AIs (ADR 0007, ADR 0016). */
function buildRegistry(
  options: AiProvidersOptions,
  wiring: {
    settings: SettingsService;
    turns: McpTurnRegistry;
    appAi?: AppAiPlan;
  },
): ProviderRegistry {
  const { config } = options;
  return new ProviderRegistry({
    config,
    ...wiring,
    apiBaseUrl: options.apiBaseUrl ?? `http://127.0.0.1:${config.PORT}`,
    env: options.env,
    fetch: options.fetch,
    tools: options.tools,
    perTokenRunner: options.perTokenRunner,
    systemPrompt: options.systemPrompt,
    subAgentPrompt: options.subAgentPrompt,
    ownerPrincipal: options.ownerPrincipal,
    freeModels: options.house?.catalog,
    codexEnabled: options.house
      ? () => options.house?.service.codexEnabled() ?? false
      : undefined,
    spentToday: spentTodayOf(options.ledger),
  });
}

export async function createAiProviders(
  options: AiProvidersOptions,
): Promise<AiProviders> {
  const settings = await loadSettings(options);
  const turns = options.turns ?? new McpTurnRegistry();
  const lazy: { registry?: ProviderRegistry } = {};
  const lent = lateSubscriptions(options, lazy);
  const registry = buildRegistry(options, {
    settings,
    turns,
    appAi: appAiOf(options, lent),
  });
  lazy.registry = registry;
  await registry.refreshCliLookup();
  return {
    settings,
    registry,
    turns,
    llm: new DynamicLlm(() => registry.llm(options.principal)),
    lent,
  };
}
