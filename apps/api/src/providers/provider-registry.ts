import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  MODEL_ALLOWLISTS,
  isLentSubscription,
  type AiProvider,
  type LentSubscription,
  type AiStatus,
  type GeminiTier,
  type OpenRouterPlan,
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
import { GeminiAdapter } from '../adapters/gemini-adapter.js';
import { StubLlmAdapter } from '../adapters/stub-llm-adapter.js';
import type { AppConfig } from '../config.js';
import type { McpTurnRegistry } from '../mcp/mcp-turns.js';
import {
  publicLastTest,
  type ProviderCatalog,
  type SettingsService,
} from '../modules/settings/index.js';
import type { LlmPort, LlmPrice } from '../ports/llm.js';
import type { AgentLlmPort } from '../ports/llm.js';
import type {
  Escalation,
  PerTokenRunnerFactory,
  ResearchRunnerPort,
} from '../ports/research-runner.js';
import type { ResearchToolsFactory } from '../ports/research-tools.js';
import { budgetsFromConfig } from '../research-agent-factory.js';
import { resolveAiSource } from './ai-access.js';
import type { AppAiPort, LendableSubscription } from './app-ai-plan.js';
import { findExecutable } from './command-locator.js';
import { ownFreeLlm } from './own-openrouter.js';
import { PaidMeters, type TurnMeter } from './paid-meters.js';
import { TurnScopedRunner } from './turn-runner.js';
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
  /** A sub-researcher's rules for a topic, for Claude Code's sub-agent (ADR 0014). */
  readonly subAgentPrompt?: (topic: string) => string;
  /**
   * The owner's principal (KBC-010): only it may use the subscriptions (personal, KBC-007
   * BR-6) and the keys of the server's environment; guests bring their own key.
   */
  readonly ownerPrincipal?: string;
  /** The AIs the app lends (KBC-022): absent, nobody gets an app AI. */
  readonly appAi?: AppAiPort;
  /** The live free-model list (KBC-022), for one's own OpenRouter on free models. */
  readonly freeModels?: FreeModelSource;
  /** Today's own spend of a principal (the daily cap of a paid fallback, KBC-023). */
  readonly spentToday?: (principal: string) => Promise<number>;
  /** A master's switch for Codex (KBC-027); absent: on whenever Codex is configured. */
  readonly codexEnabled?: () => boolean;
}

/** Codex in "IA da aplicação": configured here, and whether its login is there. */
export interface CodexStatus {
  readonly configured: boolean;
  /** null: no sandbox runner, or it did not answer. */
  readonly loggedIn: boolean | null;
}

/** The live OpenRouter list as the registry needs it. */
export interface FreeModelSource {
  autoChain(includeRouter: boolean): string[];
  priceOf(model: string): LlmPrice | null;
}

const isSubscription = (provider: ResolvedProvider): boolean =>
  provider === 'claude-subscription' || provider === 'chatgpt-subscription';

/** How one runner is built: for whom, with which tools, and the deep model to escalate to. */
interface RunnerBuild {
  readonly principal: string;
  readonly tools?: ResearchToolsFactory;
  /** A fast runner's deep model (null: the CLI's own); undefined: no escalation. */
  readonly deepModel?: string | null;
  /** The running turn's paid meter (one's own paid fallback). */
  readonly meter?: TurnMeter;
}

/** A provider resolved for one principal: which one, its model and its key. */
export interface ProviderChoice {
  readonly provider: ResolvedProvider;
  readonly model: string | undefined;
  readonly key: string | undefined;
  /** The person's plan of that provider (KBC-023): Gemini's tier, OpenRouter's mode. */
  readonly plan?: OwnPlan;
}

/** Per-provider plans of one's own AI (ADR 0018). */
export interface OwnPlan {
  readonly gemini?: GeminiTier;
  readonly openrouter?: OpenRouterPlan;
}

interface ChoiceOverride {
  readonly provider?: ResolvedProvider;
  readonly model?: string;
  readonly key?: string;
  /** Whose model: the fast one (default) or the deep one (KBC-011). */
  readonly profile?: ResearchProfile;
}

/** How long a logged-out CLI keeps the lent subscription unavailable (ADR 0019). */
const LOGGED_OUT_PAUSE_MS = 10 * 60 * 1000;

/** How long Codex's sandbox gets to say whether the owner's login is there. */
const CODEX_STATUS_TIMEOUT_MS = 5_000;
/** Its answer is kept this long: every house view would start a `codex login status`. */
const CODEX_STATUS_TTL_MS = 30_000;

/** A failure that makes a lent subscription unavailable for a while. */
const pausesLending = (kind: LentSubscription, code: string): boolean =>
  code === 'CLI_LOGIN_REQUIRED' ||
  // The runner did not answer: Codex's container is down (ADR 0020). Any other failed
  // turn (a model error, a usage limit) pauses nothing.
  (kind === 'chatgpt-subscription' && code === 'CLI_MISSING');

/** Which key a connection test was about, kept with it; null for the subscriptions. */
const keyIdOf = (key: string | undefined): string | null =>
  key ? fingerprint(key) : null;

/** A key's fingerprint for cache ids: the key itself is kept only by the adapter. */
const fingerprint = (key: string | undefined): string =>
  key ? createHash('sha256').update(key).digest('base64url').slice(0, 16) : '';

export const choiceId = (
  kind: string,
  principal: string,
  c: ProviderChoice,
): string =>
  [
    kind,
    principal,
    c.provider,
    c.model ?? '',
    fingerprint(c.key),
    c.plan ? JSON.stringify(c.plan) : '',
  ].join('|');

/**
 * The AI provider of each principal (KBC-007, ADR 0007): their Settings first, then the
 * environment (BR-4). Every call resolves again, so switching applies on the next request
 * (FR-5); built adapters are reused while the choice stays the same (price/balance caches).
 */
export class ProviderRegistry implements ProviderCatalog {
  private readonly cache = new Map<string, LlmPort | ResearchRunnerPort>();
  /** One's own paid fallback in flight, every open turn of every person (KBC-023). */
  private readonly meters = new PaidMeters();
  /** The last answer of Codex's sandbox about the login (CODEX_STATUS_TTL_MS). */
  private codexStatusCache: { status: CodexStatus; at: number } | null = null;
  /** Until when each lent subscription counts as unavailable after a logged-out CLI. */
  private readonly loggedOutUntil: Record<LentSubscription, number> = {
    'claude-subscription': 0,
    'chatgpt-subscription': 0,
  };
  /** Whether `claude` was on PATH at the last lookup (boot, then every provider list). */
  private claudeOnPath = false;

  constructor(private readonly options: ProviderRegistryOptions) {}

  /**
   * One of the owner's subscriptions as it can be lent to a person (KBC-024, KBC-027; ADR 0019,
   * ADR 0020): his CLI and his models for the profile, never escalating (a fast question counts
   * 1); Codex only in its sandbox (or the owner's Mac in local mode). The owner check for
   * subscriptions stays for a person's own choice; this path is the app AI's.
   */
  lendable(kind: LentSubscription): LendableSubscription {
    const owner = this.options.ownerPrincipal ?? 'owner';
    const choiceFor = (profile: ResearchProfile) =>
      this.choice(owner, { provider: kind, profile });
    return {
      available: () =>
        this.subscriptionReady(kind) && this.now() >= this.loggedOutUntil[kind],
      llm: () => new DisabledLlm(),
      runner: (profile) =>
        kind === 'claude-subscription'
          ? new ClaudeCliRunner(
              this.cliOptions('claude', choiceFor(profile), {
                principal: owner,
              }),
            )
          : new CodexCliRunner(
              this.codexOptions(choiceFor(profile), { principal: owner }),
            ),
      failed: (code) => {
        // A logged-out CLI (or Codex's container down) fails every lent turn: people fall
        // back meanwhile (ADR 0019, ADR 0020).
        if (!pausesLending(kind, code)) return;
        this.loggedOutUntil[kind] = this.now() + LOGGED_OUT_PAUSE_MS;
        // Ask the sandbox again next time instead of trusting its last answer.
        if (kind === 'chatgpt-subscription') this.codexStatusCache = null;
      },
    };
  }

  private subscriptionReady(kind: LentSubscription): boolean {
    if (kind === 'claude-subscription') return this.claudeOnPath;
    // The sandbox said, less than 30 s ago, that the owner's login is not there: nothing to
    // lend (QA N-2); an older answer is not trusted (review R3).
    const cached = this.codexStatusCache;
    const loggedOut =
      cached !== null &&
      this.now() - cached.at < CODEX_STATUS_TTL_MS &&
      cached.status.loggedIn === false;
    return this.codexReady() && !loggedOut;
  }

  /** Where Codex runs (ADR 0020): its sandbox runner, the owner's Mac (local), or nowhere. */
  private codexMode(): 'sandbox' | 'local' | null {
    const { config } = this.options;
    if (config.KB_CHAT_CODEX_RUNNER_URL) return 'sandbox';
    return config.KB_CHAT_CODEX ? 'local' : null;
  }

  /** Codex answers only while it is configured and a master turned it on (KBC-027 BR-1). */
  private codexReady(): boolean {
    return this.codexMode() !== null && (this.options.codexEnabled?.() ?? true);
  }

  /** "IA da aplicação" > Codex: configured, and whether the owner's login is there. */
  async codexStatus(): Promise<CodexStatus> {
    const cached = this.codexStatusCache;
    if (cached && this.now() - cached.at < CODEX_STATUS_TTL_MS)
      return cached.status;
    const status = await this.readCodexStatus();
    this.codexStatusCache = { status, at: this.now() };
    return status;
  }

  private async readCodexStatus(): Promise<CodexStatus> {
    const url = this.options.config.KB_CHAT_CODEX_RUNNER_URL;
    const configured = this.codexMode() !== null;
    if (!url) return { configured, loggedIn: null };
    try {
      const response = await fetch(`${url}/status`, {
        signal: AbortSignal.timeout(CODEX_STATUS_TIMEOUT_MS),
      });
      const body: unknown = await response.json();
      const loggedIn =
        typeof body === 'object' && body !== null && 'loggedIn' in body
          ? body.loggedIn === true
          : null;
      return { configured, loggedIn };
    } catch {
      // The sandbox is not running (COMPOSE_PROFILES without codex) or did not answer.
      return { configured, loggedIn: null };
    }
  }

  private now(): number {
    return Date.now();
  }

  /** Looks `claude` up again; the default provider depends on it (BR-4). */
  async refreshCliLookup(): Promise<void> {
    this.claudeOnPath = (await this.locateCli('claude-subscription')) !== null;
  }

  /**
   * The provider answering now for the principal (ADR 0016): an enforced app AI, else their
   * own choice, else their app AI; the local defaults only on the owner's Mac; else the stub
   * of tests, else none.
   */
  active(principal: string): ResolvedProvider {
    const saved =
      this.options.settings.snapshot(principal)?.ai.provider ?? null;
    const local = this.localDefault(principal, saved);
    if (local) return local;
    const source = this.sourceOf(principal, saved);
    if (source.source === 'app') return 'app';
    if (source.source === 'own' && this.mayUse(principal, source.provider))
      return source.provider;
    return this.options.config.KB_CHAT_LLM === 'stub' ? 'stub' : 'none';
  }

  /** Which AI serves the signed-in person and who pays, for Settings and the composer. */
  async status(principal: string): Promise<AiStatus> {
    await this.options.settings.load(principal);
    const active = this.active(principal);
    const app = this.options.appAi;
    const assignment = app?.assignment(principal);
    const quota = active === 'app' && app ? await app.quotaOf(principal) : null;
    const source =
      active === 'app' ? 'app' : active === 'none' ? 'none' : 'own';
    const free = this.isFree(principal, active);
    const paying = source === 'own' && !free && this.paysPerToken(active);
    return {
      source,
      appAi: active === 'app' ? (assignment?.appAi ?? null) : null,
      provider: active === 'none' ? null : active,
      remainingToday: quota?.remaining ?? null,
      dailyResearches: quota?.daily ?? null,
      enforced: assignment?.enforced ?? false,
      spentTodayUsd: paying
        ? ((await this.options.spentToday?.(principal)) ?? 0)
        : null,
      dailyCapUsd: paying ? this.dailyCapUsd(principal) : null,
      free,
      lastTest: this.lastTestOf(principal, active),
    };
  }

  /**
   * The last test, only when it was about the AI serving now and the key in use: a test of
   * another provider or of a typed, unsaved key says nothing about it (KBC-023 review M2, R2-03).
   */
  private lastTestOf(principal: string, active: ResolvedProvider) {
    const test = this.options.settings.snapshot(principal)?.ai.lastTest ?? null;
    const inUse = keyIdOf(this.key(principal, active));
    return test?.provider === active && test.keyId === inUse
      ? publicLastTest(test)
      : null;
  }

  /** The serving AI costs nothing: the app's, or one's own on free models (ADR 0018). */
  private isFree(principal: string, active: ResolvedProvider): boolean {
    if (active === 'app') return true;
    const plan = this.choice(principal, { provider: active }).plan;
    if (active === 'gemini') return plan?.gemini !== 'paid';
    const openrouter = plan?.openrouter;
    // A paid model the list does not price is never used (it stays out of the chain).
    const paid = openrouter?.paidModel ?? null;
    const usable = paid !== null && this.options.freeModels?.priceOf(paid);
    return active === 'openrouter' && openrouter?.mode === 'free' && !usable;
  }

  private paysPerToken(active: ResolvedProvider): boolean {
    return active !== 'stub' && PROVIDERS[active].billing === 'per-token';
  }

  private sourceOf(principal: string, chosen: AiProvider | null) {
    const assignment = this.options.appAi?.assignment(principal) ?? {
      appAi: 'none' as const,
      enforced: false,
    };
    return resolveAiSource({
      chosen,
      appAi: assignment.appAi,
      enforced: assignment.enforced,
      appAvailable: this.options.appAi?.available(assignment.appAi) ?? false,
    });
  }

  /** ADR 0007's defaults (the Claude CLI, then env keys), only with KB_CHAT_AI_DEFAULTS=local. */
  private localDefault(
    principal: string,
    saved: AiProvider | null,
  ): ResolvedProvider | null {
    if (!this.localDefaults() || !this.isOwner(principal) || saved !== null)
      return null;
    const fallback = defaultProvider(this.options.config, this.claudeOnPath);
    return fallback === 'none' ? null : fallback;
  }

  private localDefaults(): boolean {
    return this.options.config.KB_CHAT_AI_DEFAULTS === 'local';
  }

  /** Subscriptions are personal: only the owner's (KBC-007 BR-6). */
  private mayUse(principal: string, provider: AiProvider): boolean {
    return !isSubscription(provider) || this.isOwner(principal);
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
      ...this.planOf(principal, provider),
    };
  }

  /** The saved plan of Gemini or OpenRouter (KBC-023); none for other providers. */
  private planOf(
    principal: string,
    provider: ResolvedProvider,
  ): { plan?: OwnPlan } {
    const ai = this.options.settings.snapshot(principal)?.ai;
    if (provider === 'gemini')
      return { plan: { gemini: ai?.gemini.tier ?? 'free' } };
    if (provider === 'openrouter' && ai)
      return { plan: { openrouter: ai.openrouter } };
    return {};
  }

  /** Own OpenRouter on free models with a paid model: a fresh runner per turn (its meter). */
  private perTurn(choice: ProviderChoice): boolean {
    const plan = choice.plan?.openrouter;
    return plan?.mode === 'free' && plan.paidModel !== null;
  }

  private isOwnFree(choice: ProviderChoice): boolean {
    return (
      choice.provider === 'openrouter' &&
      choice.plan?.openrouter?.mode === 'free'
    );
  }

  llm(principal: string): LlmPort {
    const choice = this.choice(principal);
    const app = this.options.appAi;
    if (choice.provider === 'app' && app) return app.llm(principal);
    return this.cached(choiceId('llm', principal, choice), () =>
      this.buildLlm(choice, principal),
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
    const app = this.options.appAi;
    if (choice.provider === 'app')
      return app
        ? app.runner(principal, profile)
        : new DisabledResearchRunner();
    const deepModel =
      profile === 'fast'
        ? (this.choice(principal, { profile: 'deep' }).model ?? null)
        : undefined;
    if (this.perTurn(choice)) return this.turnScoped(choice, principal);
    // Codex's switch is read on every turn, never through the cache (KBC-027 review R1).
    if (choice.provider === 'chatgpt-subscription' && !this.codexReady())
      return new DisabledResearchRunner();
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
    const result = await testConnection({
      choice,
      signal,
      locate: () => this.locateCli(request.provider),
      llm: () => this.buildLlm(choice, principal),
      runner: () =>
        this.buildRunner(choice, { principal, tools: () => NO_TOOLS }),
    });
    this.afterOwnerTest(principal, request.provider, result.ok);
    // The status card shows the last test (KBC-023 BR-6); the key is never part of it.
    await this.options.settings.recordTest(principal, {
      provider: request.provider,
      keyId: keyIdOf(choice.key),
      ok: result.ok,
      code: result.code,
      at: new Date().toISOString(),
    });
    return result;
  }

  /** The owner logged in again: lend the subscription again at once (ADR 0019). */
  private afterOwnerTest(
    principal: string,
    provider: AiTestRequest['provider'],
    ok: boolean,
  ): void {
    if (!ok || !isLentSubscription(provider) || !this.isOwner(principal))
      return;
    this.loggedOutUntil[provider] = 0;
    this.codexStatusCache = null;
  }

  private buildLlm(
    choice: ProviderChoice,
    principal = '',
    meter?: TurnMeter,
  ): LlmPort {
    const { provider, model, key, plan } = choice;
    const fetch = this.options.fetch;
    const options = { apiKey: key, model: model ?? '', fetch };
    if (provider === 'stub') return new StubLlmAdapter();
    if (this.isOwnFree(choice) && plan?.openrouter)
      return this.ownFree(choice, principal, { plan: plan.openrouter, meter });
    if (provider === 'gemini')
      return new GeminiAdapter({
        ...options,
        freeTier: plan?.gemini !== 'paid',
      });
    if (provider === 'openrouter')
      return new OpenRouterAdapter({
        ...options,
        reasoning: this.options.config.KB_CHAT_REASONING,
      });
    if (provider === 'anthropic') return new AnthropicAdapter(options);
    if (provider === 'openai') return new OpenAiAdapter(options);
    return new DisabledLlm();
  }

  /** One's own paid fallback: its meter opens with the turn and closes after its record. */
  private turnScoped(choice: ProviderChoice, principal: string) {
    return new TurnScopedRunner(this.buildRunner(choice, { principal }), () => {
      const meter = this.meters.openTurn(principal);
      return {
        runner: this.buildRunner(choice, { principal, meter }),
        finish: () => this.meters.close(principal, meter),
      };
    });
  }

  private ownFree(
    { key }: ProviderChoice,
    principal: string,
    { plan, meter }: { plan: OpenRouterPlan; meter?: TurnMeter },
  ): LlmPort {
    const models = this.options.freeModels;
    return ownFreeLlm({
      principal,
      key,
      plan,
      autoChain: (router) => models?.autoChain(router) ?? [],
      priceOf: (id) => models?.priceOf(id) ?? null,
      spentToday: (who) => this.options.spentToday?.(who) ?? Promise.resolve(0),
      dailyCapUsd: () => this.dailyCapUsd(principal),
      fetch: this.options.fetch,
      meters: this.meters,
      // Outside a turn (the side panel's model) nothing is spent: an unregistered meter.
      meter: meter ?? { reserved: 0, spent: 0 },
    });
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
      return this.codexReady()
        ? new CodexCliRunner(this.codexOptions(choice, build))
        : new DisabledResearchRunner();
    const llm = this.buildLlm(choice, principal, build.meter);
    const loop = this.options.perTokenRunner;
    if (!loop || !isAgentLlm(llm)) return new DisabledResearchRunner();
    // On free models the daily cap gates only the paid fallback (inside its gate).
    const cap = this.isOwnFree(choice)
      ? () => Number.POSITIVE_INFINITY
      : () => this.dailyCapUsd(principal);
    const scope = { principal, dailyCapUsd: cap };
    return loop(llm, scope, this.perTokenEscalation(choice, build));
  }

  private perTokenEscalation(
    choice: ProviderChoice,
    { principal, deepModel }: RunnerBuild,
  ): Escalation<AgentLlmPort> | undefined {
    // Free models answer both profiles: no escalation, as on the house plan.
    if (deepModel === undefined || this.isOwnFree(choice)) return undefined;
    const deep = this.buildLlm(
      { ...choice, model: deepModel ?? undefined },
      principal,
    );
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
      budgets: budgetsFromConfig(config),
      bin: cli === 'claude' ? config.CLAUDE_BIN : config.CODEX_BIN,
      model: choice.model,
      apiBaseUrl: this.options.apiBaseUrl,
      turns: this.options.turns,
      workDir: join(config.KB_CHAT_STATE_DIR, 'cli', cli),
      env: this.options.env,
      tools,
      systemPrompt: this.options.systemPrompt,
      subAgentPrompt: this.options.subAgentPrompt,
    };
  }

  /** Codex's options: its sandbox runner when there is one (ADR 0020). */
  private codexOptions(choice: ProviderChoice, build: RunnerBuild) {
    const { config } = this.options;
    const url = config.KB_CHAT_CODEX_RUNNER_URL;
    return {
      ...this.cliOptions('codex', choice, build),
      ...(url && { runner: { url } }),
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
    if (provider === 'stub' || provider === 'none' || provider === 'app')
      return undefined;
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
    // The env keys are a local default only (ADR 0016): never in production.
    if (own || !this.isOwner(principal) || !this.localDefaults()) return own;
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
    if (id === 'app') return this.appReason(principal);
    if (id === 'chatgpt-subscription') {
      if (!this.codexReady()) return 'not-enabled';
      // In the sandbox, Codex is in its own container, not on this PATH (ADR 0020).
      if (this.codexMode() === 'sandbox') return null;
    }
    if (PROVIDERS[id].cliBin && !cliFound) return 'cli-missing';
    if (isKeyProvider(id) && this.keySource(principal, id) === null)
      return 'key-missing';
    return null;
  }

  /** "IA da aplicação" is offered while an app AI is assigned to the person and can answer. */
  private appReason(principal: string): ProviderInfo['reason'] {
    const app = this.options.appAi;
    const appAi = app?.assignment(principal).appAi ?? 'none';
    return app?.available(appAi) ? null : 'app-unavailable';
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
      freeModel: id === 'none' || id === 'app' || !MODEL_ALLOWLISTS[id],
    };
  }
}
