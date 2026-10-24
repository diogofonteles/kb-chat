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
