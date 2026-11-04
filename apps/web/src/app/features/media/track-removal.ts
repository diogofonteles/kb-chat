import { HttpErrorResponse } from '@angular/common/http';
import { z } from 'zod';

const refusalSchema = z.object({
  error: z.object({
    details: z.object({
      reason: z.literal('has-tracks'),
      tracks: z.array(z.string()),
    }),
  }),
});

/** The tracks a removal would take (KBC-068): the API refuses until they were shown. */
export function tracksInTheWay(err: unknown): readonly string[] | null {
  if (!(err instanceof HttpErrorResponse) || err.status !== 409) return null;
  const refusal = refusalSchema.safeParse(err.error);
  return refusal.success ? refusal.data.error.details.tracks : null;
}

/** How many titles the dialog lists before "+N". */
const LISTED = 5;

export function trackListText(titles: readonly string[]): string {
  const listed = titles.slice(0, LISTED).join(', ');
  const others = titles.length - LISTED;
  return others > 0 ? `${listed} +${others}` : listed;
}
