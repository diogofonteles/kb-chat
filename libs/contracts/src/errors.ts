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
  /** The same file is already in this collection; `details.media` names it (KBC-035 BR-2). */
  'MEDIA_DUPLICATE',
  /** The upload would pass the person's quota; `details.quotaBytes` says it (KBC-035 BR-1). */
  'MEDIA_QUOTA_EXCEEDED',
  /** A body the route does not read: a part of an upload in another format (KBC-035). */
  'UNSUPPORTED_MEDIA_TYPE',
  /** The interrupted upload's parts were deleted after 24 h (KBC-035 BR-3). */
  'MEDIA_UPLOAD_EXPIRED',
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
  /** The term list would pass whisper's prompt limit (KBC-040 BR-2). */
  'TERMS_OVER_LIMIT',
  'CONSENT_REQUIRED',
  /** No print while earlier revocations are unknown (ADR 0032 §4). */
  'VOICE_LIST_LOST',
  /** No print while others can write the revocation list (ADR 0032 §3). */
  'VOICE_LIST_EXPOSED',
  /** A revocation took effect but is not on the list yet (ADR 0032 §4); the next start retries. */
  'VOICE_LIST_NOT_WRITTEN',
  'PLAN_REFUSED',
  /** Groq is off, or has no key, for a transcription a master sends to it (KBC-037). */
  'GROQ_UNAVAILABLE',
  /** A word correction refused (KBC-093): `details.reason` says why (word-changed, …). */
  'CORRECTION_CONFLICT',
  /** The recording was transcribed again since the person read it (KBC-093 BR-6). */
  'TRANSCRIPT_CHANGED',
  /** A correction's text or batch the rules refuse (KBC-093 BR-3, BR-12). */
  'CORRECTION_INVALID',
  /** A level with that code (ignoring case and accents) is already in the scale (KBC-103). */
  'LEVEL_CODE_TAKEN',
  /** AI research in a collection with levels waits for KBC-104 (non-masters, KBC-103 BR-10). */
  'LEVELS_PENDING',
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
