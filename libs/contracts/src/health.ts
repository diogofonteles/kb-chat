import { z } from 'zod';

export const healthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  search: z.enum(['ok', 'degraded', 'down']),
  catalog: z.object({ documents: z.number().int().nonnegative() }),
});
export type Health = z.infer<typeof healthSchema>;
