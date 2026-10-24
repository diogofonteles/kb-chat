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
  FORBIDDEN_HOST: 403,
  INTERNAL: 500,
};

/** Domain error carrying a stable contract code; the root handler maps it to the envelope. */
export class AppError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = STATUS_BY_CODE[code];
  }
}
