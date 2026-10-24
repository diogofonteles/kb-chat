import { z } from 'zod';

/** GET /api/v1/spend/today: the principal's per-token spend today and the daily cap. */
export const spendTodaySchema = z.object({
  usd: z.number().nonnegative(),
  capUsd: z.number().nonnegative(),
  /** False when no provider able to research is available. */
  configured: z.boolean(),
});
export type SpendToday = z.infer<typeof spendTodaySchema>;
