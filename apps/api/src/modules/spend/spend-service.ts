import type { SpendToday } from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { LlmPort } from '../../ports/llm.js';
import type { SpendLedgerPort } from '../../ports/spend-ledger.js';

/** Rough size of a token in Portuguese text, used when the provider reports no usage. */
const CHARS_PER_TOKEN = 3.5;

export const tokensOf = (text: string): number =>
  Math.ceil(text.length / CHARS_PER_TOKEN);

export interface SpendServiceDeps {
  readonly llm: LlmPort;
  readonly ledger: SpendLedgerPort;
  /** Read on every check: Settings may change it between turns (KBC-007). */
  readonly dailyCapUsd: () => number;
  /** Whether research can run now (the side panel's `configured`); default: the model's own. */
  readonly configured?: () => boolean;
  /** Who spends (ADR 0005: the owner until release 2 adds logins). */
  readonly principal: string;
}

export interface CallUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Real cost when the provider reports it; null prices it from the price list. */
  readonly usd: number | null;
}

export interface TurnSpend {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usd: number;
  readonly interrupted: boolean;
  /** The model that answered, when the provider named it (fallback chains, KBC-022). */
  readonly model?: string;
}

/** Spend controls of ADR 0004, kept by ADR 0006: the ledger, the daily cap and the credit check. */
export class SpendService {
  constructor(private readonly deps: SpendServiceDeps) {}

  /** Upper bound of one model call: the prompt plus the whole output budget. */
  async estimate(promptText: string, maxOutputTokens: number): Promise<number> {
    if (this.deps.llm.billing === 'subscription') return 0;
    const price = await this.deps.llm.price();
    return tokensOf(promptText) * price.input + maxOutputTokens * price.output;
  }

  /** Refuses before any spend that would cross the daily cap or the account credit. */
  async guard(estimateUsd: number): Promise<void> {
    // Nothing to pay (a subscription, a free tier): no cap to check (KBC-023 review).
    if (this.deps.llm.billing !== 'per-token') return;
    const spent = await this.deps.ledger.spentToday(this.deps.principal);
    if (spent + estimateUsd > this.deps.dailyCapUsd())
      throw new AppError('DAILY_CAP_REACHED', 'Daily AI spend cap reached');
    const balance = await this.deps.llm.balance();
    if (balance !== null && balance < estimateUsd)
      throw new AppError('LLM_INSUFFICIENT_CREDIT', 'Insufficient credit');
  }

  /** Real cost when reported; otherwise priced from the price list (0 on a subscription). */
  async costOf(usage: CallUsage): Promise<number> {
    if (this.deps.llm.billing === 'subscription') return 0;
    if (usage.usd !== null) return usage.usd;
    const price = await this.deps.llm.price();
    return usage.inputTokens * price.input + usage.outputTokens * price.output;
  }

  /** A subscription turn costs nothing per token: no ledger entry (KBC-007 BR-2). */
  async record(spend: TurnSpend): Promise<void> {
    if (this.deps.llm.billing === 'subscription') return;
    await this.deps.ledger.append({
      ts: new Date().toISOString(),
      principal: this.deps.principal,
      ...spend,
      model: spend.model ?? this.deps.llm.model,
    });
  }

  async today(): Promise<SpendToday> {
    return {
      usd: await this.deps.ledger.spentToday(this.deps.principal),
      capUsd: this.deps.dailyCapUsd(),
      configured: this.deps.configured?.() ?? this.deps.llm.configured(),
    };
  }
}
