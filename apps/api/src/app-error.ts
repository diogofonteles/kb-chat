import type { ApiErrorCode } from '@kb-chat/contracts';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  TOPIC_NOT_FOUND: 404,
  INDEX_MISSING: 409,
  SEARCH_UNAVAILABLE: 503,
  DOCUMENT_NOT_FOUND: 404,
  LLM_NOT_CONFIGURED: 409,
  LLM_INSUFFICIENT_CREDIT: 402,
  DAILY_CAP_REACHED: 429,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  ANSWER_IN_PROGRESS: 409,
  FORBIDDEN_HOST: 403,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_INVITED: 403,
  CSRF_REJECTED: 403,
  LAST_MASTER: 409,
  OWNER_PROTECTED: 409,
  ALREADY_INVITED: 409,
  AUTH_UNAVAILABLE: 503,
  INVALID_CODE: 400,
  REQUEST_EXPIRED: 400,
  ALREADY_REQUESTED: 409,
  REQUEST_COOLDOWN: 429,
  HOUSE_QUOTA_EXHAUSTED: 429,
  AI_CAPACITY_EXHAUSTED: 503,
  PROVIDER_UNAVAILABLE: 503,
  MEDIA_NOT_FOUND: 404,
  MEDIA_NOT_READY: 409,
  PAYLOAD_TOO_LARGE: 413,
  MEDIA_CONFLICT: 409,
  BOOKMARK_LIMIT: 409,
  NOT_WHILE_ACTING: 403,
  VIEW_CHANGED: 409,
  TOPIC_EXISTS: 409,
  MEDIA_SPEND_CAP: 429,
  EDIT_STALE: 412,
  EDIT_VERSION_REQUIRED: 428,
  TRACKS_INVALID: 422,
  TERMS_OVER_LIMIT: 422,
  CONSENT_REQUIRED: 422,
  VOICE_LIST_LOST: 409,
  VOICE_LIST_EXPOSED: 409,
  VOICE_LIST_NOT_WRITTEN: 503,
  PLAN_REFUSED: 422,
  INTERNAL: 500,
};

export interface AppErrorOptions {
  /** Sent to the client for 4xx only. */
  readonly details?: unknown;
  /** Logged, never sent. */
  readonly cause?: unknown;
}

/** Domain error carrying a stable contract code; the root handler maps it to the envelope. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly details: unknown;

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    options: AppErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.statusCode = STATUS_BY_CODE[code];
    this.details = options.details;
  }
}
