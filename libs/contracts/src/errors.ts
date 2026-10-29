import { z } from 'zod';

export const API_ERROR_CODES = [
  'TOPIC_NOT_FOUND',
  'INDEX_MISSING',
  'SEARCH_UNAVAILABLE',
  'DOCUMENT_NOT_FOUND',
  'LLM_NOT_CONFIGURED',
  'LLM_INSUFFICIENT_CREDIT',
  'DAILY_CAP_REACHED',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'RATE_LIMITED',
  'ANSWER_IN_PROGRESS',
  'FORBIDDEN_HOST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_INVITED',
  'CSRF_REJECTED',
  'LAST_MASTER',
  'OWNER_PROTECTED',
  'ALREADY_INVITED',
  'AUTH_UNAVAILABLE',
  'INVALID_CODE',
  'REQUEST_EXPIRED',
  'ALREADY_REQUESTED',
  'REQUEST_COOLDOWN',
  /** The person's house-plan researches of today are spent (KBC-022). */
  'HOUSE_QUOTA_EXHAUSTED',
  /** The free models have no capacity left now (KBC-022). */
  'AI_CAPACITY_EXHAUSTED',
  /** An AI provider's account API did not answer (KBC-022: OpenRouter key management). */
  'PROVIDER_UNAVAILABLE',
  /** A media item that does not exist or sits in a collection the person cannot see. */
  'MEDIA_NOT_FOUND',
  /** The media item is not converted yet (or failed): nothing to stream. */
  'MEDIA_NOT_READY',
  /** The upload is larger than announced or than the limit. */
  'PAYLOAD_TOO_LARGE',
  /** The media item is not waiting for its file (already sent, or abandoned). */
  'MEDIA_CONFLICT',
  'INTERNAL',
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
