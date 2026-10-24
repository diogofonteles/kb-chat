import type { ResearchProfile } from '@kb-chat/contracts';

/** Tool calls per answer in the deep profile (BR-3); then one last call without tools writes the answer. */
export const MAX_TOOL_STEPS = 15;
/** Tool calls per answer in the fast profile (KBC-011). */
export const FAST_TOOL_STEPS = 6;
/** Output budget of each model call. */
export const MAX_OUTPUT_TOKENS = 2_000;

/** The step budget of each research profile (KBC-011, ADR 0009). */
export const PROFILE_STEPS: Readonly<Record<ResearchProfile, number>> = {
  fast: FAST_TOOL_STEPS,
  deep: MAX_TOOL_STEPS,
};
