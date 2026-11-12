import { z } from 'zod';

export const healthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  search: z.enum(['ok', 'degraded', 'down']),
  /**
   * Whether the vault's catalog is loaded. No count: the route is public, and a count of
   * every document would move with the ones above anyone's level (KBC-111, ADR 0036).
   */
  catalog: z.object({ loaded: z.boolean() }),
});
export type Health = z.infer<typeof healthSchema>;
