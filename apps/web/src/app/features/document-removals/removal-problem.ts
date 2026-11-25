import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';

/** Why it was not done: another tab, or another master, may have done it first. */
export function problemOf(err: unknown): string {
  const code = toUiErrorCode(err);
  return code === 'NOT_FOUND' || code === 'MEDIA_CONFLICT'
    ? $localize`:@@removal.changed:Isto mudou enquanto você agia. Veja a lista de removidos.`
    : errorMessage(code);
}
