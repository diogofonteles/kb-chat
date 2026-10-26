import { z } from 'zod';

/** GET /api/v1/spend/today: the principal's per-token spend today and the daily cap. */
export const spendTodaySchema = z.object({
  usd: z.number().nonnegative(),
  capUsd: z.number().nonnegative(),
  /** False when no provider able to research is available. */
  configured: z.boolean(),
});
export type SpendToday = z.infer<typeof spendTodaySchema>;

/** GET /api/v1/spend/people: today's per-token spend of each person, for the owner only (KBC-010 BR-6). */
export const spendByPersonSchema = z.object({
  items: z.array(
    z.object({
      email: z.email(),
      usd: z.number().nonnegative(),
    }),
  ),
});
export type SpendByPerson = z.infer<typeof spendByPersonSchema>;
