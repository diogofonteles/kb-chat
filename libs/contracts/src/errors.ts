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
  'FORBIDDEN_HOST',
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
