import type { ResearchProfile } from '@kb-chat/contracts';

/** Tool calls per answer in the deep profile (BR-3); then one last call without tools writes the answer. */
export const MAX_TOOL_STEPS = 15;
/** Tool calls per answer in the fast profile (KBC-011). */
export const FAST_TOOL_STEPS = 6;
/** Output budget of each model call (fast and deep profiles). */
export const MAX_OUTPUT_TOKENS = 2_000;
/** The exhaustive profile's defaults (KBC-017, ADR 0013); the steps and output are configurable. */
export const EXHAUSTIVE_TOOL_STEPS = 80;
export const EXHAUSTIVE_OUTPUT_TOKENS = 16_000;
/** What the spend guard prices per exhaustive call: its long output comes once, at the end. */
const EXHAUSTIVE_GUARD_OUTPUT_TOKENS = 4_000;
const EXHAUSTIVE_MINUTES = 30;
/** Estimated prompt tokens past which the exhaustive loop compacts old tool results. */
const EXHAUSTIVE_COMPACT_TOKENS = 60_000;

/** How an exhaustive turn sweeps its planned set (KBC-030, ADR 0021). */
export interface SweepBudget {
  /** Batches at once on a per-token model. */
  readonly parallel: number;
  /** Output tokens of one batch call. */
  readonly outputTokens: number;
  /** Model requests one turn may make: planning, batches and the answer. */
  readonly maxRequests: number;
}

/** The default of KB_CHAT_SWEEP_MAX_REQUESTS. */
export const SWEEP_MAX_REQUESTS = 250;

export const SWEEP: SweepBudget = {
  parallel: 3,
  outputTokens: 4_000,
  maxRequests: SWEEP_MAX_REQUESTS,
};

/** How far one research profile may go (KBC-011, KBC-017). */
export interface ProfileBudget {
  /** Tool calls per answer. */
  readonly steps: number;
  /** Output tokens requested per model call. */
  readonly outputTokens: number;
  /** Output tokens the spend guard prices per call before it is made. */
  readonly guardOutputTokens: number;
  /** Wall-clock ceiling of the research, then the answer; null: none. */
  readonly maxMinutes: number | null;
  /** Estimated prompt tokens past which old tool results are compacted; null: never. */
  readonly compactTokens: number | null;
  /** The app-driven sweep (ADR 0021); null: the profile does not sweep. */
  readonly sweep: SweepBudget | null;
}

export type ResearchBudgets = Readonly<Record<ResearchProfile, ProfileBudget>>;

/** The exhaustive profile's configurable part (KB_CHAT_EXHAUSTIVE_STEPS, KB_CHAT_EXHAUSTIVE_OUTPUT_TOKENS). */
export interface ExhaustiveSettings {
  readonly steps?: number;
  readonly outputTokens?: number;
  /** KB_CHAT_SWEEP_MAX_REQUESTS (KBC-030). */
  readonly sweepRequests?: number;
}

const shortBudget = (steps: number): ProfileBudget => ({
  steps,
  outputTokens: MAX_OUTPUT_TOKENS,
  guardOutputTokens: MAX_OUTPUT_TOKENS,
  maxMinutes: null,
  compactTokens: null,
  sweep: null,
});

/** The budgets of every profile; the exhaustive one takes the server's settings. */
export function researchBudgets(
  exhaustive: ExhaustiveSettings = {},
): ResearchBudgets {
  const outputTokens = exhaustive.outputTokens ?? EXHAUSTIVE_OUTPUT_TOKENS;
  return {
    fast: shortBudget(FAST_TOOL_STEPS),
    deep: shortBudget(MAX_TOOL_STEPS),
    exhaustive: {
      steps: exhaustive.steps ?? EXHAUSTIVE_TOOL_STEPS,
      outputTokens,
      guardOutputTokens: Math.min(outputTokens, EXHAUSTIVE_GUARD_OUTPUT_TOKENS),
      maxMinutes: EXHAUSTIVE_MINUTES,
      compactTokens: EXHAUSTIVE_COMPACT_TOKENS,
      sweep: {
        ...SWEEP,
        maxRequests: exhaustive.sweepRequests ?? SWEEP_MAX_REQUESTS,
      },
    },
  };
}

export const DEFAULT_BUDGETS: ResearchBudgets = researchBudgets();

/** The step budget of each research profile with the default settings (KBC-011, ADR 0009/0013). */
export const PROFILE_STEPS: Readonly<Record<ResearchProfile, number>> = {
  fast: DEFAULT_BUDGETS.fast.steps,
  deep: DEFAULT_BUDGETS.deep.steps,
  exhaustive: DEFAULT_BUDGETS.exhaustive.steps,
};
