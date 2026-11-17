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

/** The tracks the dialog lists one by one, the last line "+N" when there are more. */
export function trackListRows(titles: readonly string[]): readonly string[] {
  const others = titles.length - LISTED;
  return others > 0
    ? [...titles.slice(0, LISTED), `+${others}`]
    : titles.slice(0, LISTED);
}

/** The heading over that list (media-library-remove-tracks: "Também remove 3 faixas:"). */
export function alsoRemovesCount(count: number): string {
  return count === 1
    ? $localize`:@@media.removeTracksCountOne:Também remove 1 faixa:`
    : $localize`:@@media.removeTracksCount:Também remove ${count}:count: faixas:`;
}

/** The line of the removal dialog that names what goes with the recording (KBC-068). */
export function alsoRemovesText(titles: readonly string[]): string {
  const listed = trackListText(titles);
  return titles.length === 1
    ? $localize`:@@media.removeTracksOne:Também remove 1 faixa: ${listed}:list:`
    : $localize`:@@media.removeTracks:Também remove ${titles.length}:count: faixas: ${listed}:list:`;
}
