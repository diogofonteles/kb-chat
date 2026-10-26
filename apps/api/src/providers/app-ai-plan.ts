import {
  DEFAULT_PERSON_AI,
  type AppAi,
  type PersonAi,
  type ResearchProfile,
} from '@kb-chat/contracts';
import { DisabledLlm } from '../adapters/disabled-llm.js';
import { OpenRouterAdapter } from '../adapters/openrouter-adapter.js';
import type { Viewer } from '../modules/auth/index.js';
import type {
  FreeModelCatalog,
  HouseAiService,
  HouseQuota,
} from '../modules/house-ai/index.js';
import type { LlmPort } from '../ports/llm.js';
import type {
  PerTokenRunnerFactory,
  ResearchRunnerPort,
} from '../ports/research-runner.js';
import type { SpendLedgerPort } from '../ports/spend-ledger.js';
import { DisabledResearchRunner } from './dynamic-ports.js';
import { HouseLlm, type PaidFallbackGate } from './house-llm.js';
import { HouseResearchRunner } from './house-runner.js';
import { PaidMeters, type TurnMeter } from './paid-meters.js';

/** Which app AI serves a principal and whether the master enforced it (ADR 0016). */
export interface AppAiAssignment {
  readonly appAi: AppAi;
  readonly enforced: boolean;
}

/** An AI the app lends (not `none`). */
export type LentAi = Exclude<AppAi, 'none'>;

/**
 * One app-owned AI (ADR 0016): the house plan here; KBC-024/027 add the subscriptions as
 * new entries of the same map.
 */
export interface AppAiHandler {
  available(): boolean;
  llm(principal: string): LlmPort;
  runner(principal: string, profile: ResearchProfile): ResearchRunnerPort;
}

/** The app-owned AIs as the provider registry sees them (KBC-022). */
export interface AppAiPort {
  assignment(principal: string): AppAiAssignment;
  available(appAi: AppAi): boolean;
  /** The assigned app AI's model and runner (the registry asks only when one serves). */
  llm(principal: string): LlmPort;
  runner(principal: string, profile: ResearchProfile): ResearchRunnerPort;
  /** House researches left today and the daily quota of the principal. */
  quotaOf(principal: string): Promise<{ remaining: number; daily: number }>;
}

export interface AppAiPlanDeps {
  readonly house: HouseAiService;
  readonly catalog: FreeModelCatalog;
  readonly quota: HouseQuota;
  /** house-spend.jsonl: the paid fallback's spend, apart from people's own keys. */
  readonly houseSpend: SpendLedgerPort;
  /** The person behind a principal, from the people service's memory. */
  readonly personOf: (principal: string) => Viewer | null;
  readonly perTokenRunner?: PerTokenRunnerFactory;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  /** More app AIs beside the house plan (KBC-024, KBC-027). */
  readonly handlers?: Partial<Record<LentAi, AppAiHandler>>;
}

const startOfMonth = (now: Date): Date =>
  new Date(now.getFullYear(), now.getMonth(), 1);

/** The house plan behind the registry: assignment, model chain, quota and spend (ADR 0016). */
export class AppAiPlan implements AppAiPort {
  private readonly handlers: Partial<Record<LentAi, AppAiHandler>>;
  private readonly meters = new PaidMeters();

  constructor(private readonly deps: AppAiPlanDeps) {
    this.handlers = { ...deps.handlers, house: this.houseHandler() };
  }

  assignment(principal: string): AppAiAssignment {
    const ai = this.aiOf(principal);
    const appAi =
      ai.appAi === 'default' ? this.deps.house.defaultAppAi() : ai.appAi;
    return { appAi, enforced: ai.enforced };
  }

  available(appAi: AppAi): boolean {
    return appAi !== 'none' && (this.handlers[appAi]?.available() ?? false);
  }

  llm(principal: string): LlmPort {
    return this.handlerOf(principal)?.llm(principal) ?? new DisabledLlm();
  }

  runner(principal: string, profile: ResearchProfile): ResearchRunnerPort {
    return (
      this.handlerOf(principal)?.runner(principal, profile) ??
      new DisabledResearchRunner()
    );
  }

  private handlerOf(principal: string): AppAiHandler | undefined {
    const { appAi } = this.assignment(principal);
    return appAi === 'none' ? undefined : this.handlers[appAi];
  }

  private houseHandler(): AppAiHandler {
    return {
      available: () =>
        this.deps.house.isConnected() && this.deps.house.chain().length > 0,
      llm: (principal) => this.houseLlm(principal),
      runner: (principal) => this.houseRunner(principal),
    };
  }

  /** The house model for one turn; the paid fallback counts on the turn's meter. */
  private houseLlm(principal: string, meter?: TurnMeter): HouseLlm {
    const viewer = this.deps.personOf(principal);
    const key = this.deps.house.keyFor(viewer?.person.id ?? null);
    const adapter = new OpenRouterAdapter({
      apiKey: key ?? undefined,
      model: 'openrouter',
      fetch: this.deps.fetch,
    });
    return new HouseLlm({
      adapter,
      chain: () => this.deps.house.chain(),
      // Outside a turn (the side panel's model) nothing is spent: an unregistered meter.
      paid: this.paidGate(principal, meter ?? { reserved: 0, spent: 0 }),
    });
  }

  private houseRunner(principal: string): ResearchRunnerPort {
    const loop = this.deps.perTokenRunner;
    if (!loop) return new DisabledResearchRunner();
    const meter = this.meters.openTurn(principal);
    // No escalation on the house plan: a fast turn counts 1 and spends a fast budget.
    const inner = loop(this.houseLlm(principal, meter), {
      principal,
      dailyCapUsd: () => Number.POSITIVE_INFINITY,
      ledger: this.deps.houseSpend,
    });
    return new HouseResearchRunner({
      inner,
      quota: this.deps.quota,
      principal,
      dailyLimit: this.dailyLimit(principal),
      capacity: () => this.deps.house.freeUsage(),
      paidActive: this.paidGate(principal, meter) !== null,
      prepare: () => this.prepareTurn(principal),
      // The turn's spend is in the house ledger by now: stop counting it in flight.
      finish: () => this.meters.close(principal, meter),
    });
  }

  /**
   * The live list in memory, and the person's own OpenRouter key made again when it was
   * dropped (the house account or management key changed); a failure leaves the house key.
   */
  private async prepareTurn(principal: string): Promise<void> {
    await this.deps.house.ready();
    const viewer = this.deps.personOf(principal);
    if (!viewer) return;
    await this.deps.house
      .syncPersonKey(viewer.person, this.aiOf(principal))
      .catch(() => undefined);
  }

  async quotaOf(
    principal: string,
  ): Promise<{ remaining: number; daily: number }> {
    const daily = this.dailyLimit(principal);
    return {
      daily,
      remaining: await this.deps.quota.remaining(principal, daily),
    };
  }

  private aiOf(principal: string): PersonAi {
    return this.deps.personOf(principal)?.person.ai ?? DEFAULT_PERSON_AI;
  }

  private dailyLimit(principal: string): number {
    return (
      this.aiOf(principal).dailyResearches ??
      this.deps.house.defaultDailyResearches()
    );
  }

  /** The paid model for this person, gated by their monthly cap; null when not theirs. */
  private paidGate(
    principal: string,
    meter: TurnMeter,
  ): PaidFallbackGate | null {
    const model = this.deps.house.paidModel();
    const { enabled, monthlyCapUsd } = this.aiOf(principal).paidFallback;
    const price = model ? this.deps.catalog.priceOf(model) : null;
    if (!model || !enabled || !price) return null;
    const fits = async (pendingPlusEstimate: number) => {
      const now = this.deps.now?.() ?? new Date();
      const spent = await this.deps.houseSpend.spentSince(
        principal,
        startOfMonth(now),
      );
      return spent + pendingPlusEstimate <= monthlyCapUsd;
    };
    return {
      model,
      price,
      allowed: (estimate) =>
        this.meters.reserve(principal, { meter, estimate, fits }),
      settle: (estimate, usd) => this.meters.settle(meter, { estimate, usd }),
    };
  }
}
