import { z } from 'zod';
import {
  errorDetailsOf,
  errorMessage,
  toUiErrorCode,
} from '@core/api/api-error.js';
import { restoreRefusals } from './track-edit-labels.js';

const refusalSchema = z.object({ reason: z.string() });

/** Why a track did not come back, in words; the API's own reason when it gave one. */
export function restoreFailureText(err: unknown): string {
  const refusal = refusalSchema.safeParse(errorDetailsOf(err));
  const text = refusal.success
    ? restoreRefusals[refusal.data.reason]
    : undefined;
  return text ? text() : errorMessage(toUiErrorCode(err));
}
