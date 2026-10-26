import {
  OPENROUTER_FREE_ROUTER,
  type OpenRouterPlan,
} from '@kb-chat/contracts';
import { OpenRouterAdapter } from '../adapters/openrouter-adapter.js';
import type { LlmPrice } from '../ports/llm.js';
import { HouseLlm, type PaidFallbackGate } from './house-llm.js';
import { PaidMeters } from './paid-meters.js';

/** What one's own OpenRouter on free models needs from the app (KBC-023, ADR 0018). */
export interface OwnFreeDeps {
  readonly principal: string;
  readonly key: string | undefined;
  readonly plan: OpenRouterPlan;
  /** The house's live free list (the same chain when the person chose none). */
  readonly autoChain: (includeRouter: boolean) => string[];
  readonly priceOf: (model: string) => LlmPrice | null;
  readonly spentToday: (principal: string) => Promise<number>;
  readonly dailyCapUsd: () => number;
  readonly fetch?: typeof fetch;
}

/** The person's free chain: their choice (router last when wanted) or the live list. */
export function ownChain(
  plan: OpenRouterPlan,
  autoChain: (includeRouter: boolean) => string[],
): string[] {
  if (plan.freeModels === null) return autoChain(plan.includeRouter);
  const chosen = plan.freeModels.filter((id) => id !== OPENROUTER_FREE_ROUTER);
  return plan.includeRouter ? [...chosen, OPENROUTER_FREE_ROUTER] : chosen;
}

/**
 * One's own OpenRouter in "Só modelos gratuitos": the free chain with the person's key, and
 * the paid model last only while today's spend, the calls in flight of this runner and the
 * call's estimate fit the daily cap. A runner with a paid model is built per turn, so its
 * meter covers exactly that turn.
 */
export function ownFreeLlm(deps: OwnFreeDeps): HouseLlm {
  const adapter = new OpenRouterAdapter({
    apiKey: deps.key,
    model: 'openrouter',
    fetch: deps.fetch,
  });
  return new HouseLlm({
    adapter,
    chain: () => ownChain(deps.plan, deps.autoChain),
    paid: paidGate(deps),
  });
}

function paidGate(deps: OwnFreeDeps): PaidFallbackGate | null {
  const model = deps.plan.paidModel;
  const price = model ? deps.priceOf(model) : null;
  if (!model || !price) return null;
  const meters = new PaidMeters();
  const meter = meters.openTurn(deps.principal);
  const fits = async (pendingPlusEstimate: number) =>
    (await deps.spentToday(deps.principal)) + pendingPlusEstimate <=
    deps.dailyCapUsd();
  return {
    model,
    price,
    allowed: (estimate) =>
      meters.reserve(deps.principal, { meter, estimate, fits }),
    settle: (estimate, usd) => meters.settle(meter, { estimate, usd }),
  };
}
