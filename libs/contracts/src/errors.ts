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
  /** One person keeps at most 1 000 bookmarks per media (KBC-042). */
  'BOOKMARK_LIMIT',
  /** Only the person may do this, not a master acting as them (KBC-060). */
  'NOT_WHILE_ACTING',
  /** The tab wrote as one view (the person's or the master's) the session no longer has. */
  'VIEW_CHANGED',
  /** A collection with that slug (the name without accents) already exists (KBC-048). */
  'TOPIC_EXISTS',
  /** A media AI run would cross its own cap or the media monthly budget (KBC-067 BR-3). */
  'MEDIA_SPEND_CAP',
  /** Someone else saved this edit first (KBC-066 FR-10). */
  'EDIT_STALE',
  /** A write to an edit must name the version it read (`If-Match`, KBC-066 FR-1). */
  'EDIT_VERSION_REQUIRED',
  /** Overlapping, too short or untitled tracks; `details.problems` points at each (KBC-066). */
  'TRACKS_INVALID',
  'CONSENT_REQUIRED',
  /** A revocation took effect but is not on the list yet (ADR 0032 §4); the next start retries. */
  'VOICE_LIST_NOT_WRITTEN',
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
