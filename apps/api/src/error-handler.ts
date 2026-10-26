import type { ApiError } from '@kb-chat/contracts';
import type { FastifyBaseLogger, FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError } from './app-error.js';

interface ErrorResponse {
  readonly status: number;
  readonly body: ApiError;
}

const envelope = (
  code: ApiError['error']['code'],
  message: string,
  details?: unknown,
): ApiError => ({
  error: details === undefined ? { code, message } : { code, message, details },
});

function fromAppError(err: AppError, log: FastifyBaseLogger): ErrorResponse {
  // Server-side failures keep their cause in the log only (ND-25).
  if (err.statusCode >= 500) {
    log.error({ err }, 'request failed');
    return { status: err.statusCode, body: envelope(err.code, err.message) };
  }
  return {
    status: err.statusCode,
    body: envelope(err.code, err.message, err.details),
  };
}

function fromFrameworkError(
  err: FastifyError,
  log: FastifyBaseLogger,
): ErrorResponse {
  if (hasZodFastifySchemaValidationErrors(err) || err.validation) {
    const body = envelope(
      'VALIDATION_FAILED',
      'Invalid request',
      err.validation,
    );
    return { status: 400, body };
  }
  if (err.statusCode === 429) {
    return { status: 429, body: envelope('RATE_LIMITED', 'Too many requests') };
  }
  if (err.statusCode && err.statusCode < 500) {
    return {
      status: err.statusCode,
      body: envelope('VALIDATION_FAILED', err.message),
    };
  }
  log.error({ err }, 'unexpected error');
  return { status: 500, body: envelope('INTERNAL', 'Unexpected error') };
}

/** Single root handler: domain errors keep their code, validation is 400, the rest is 500. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    const { status, body } =
      err instanceof AppError
        ? fromAppError(err, request.log)
        : fromFrameworkError(err, request.log);
    return reply.code(status).send(body);
  });
  app.setNotFoundHandler((request, reply) => {
    const message = `Route ${request.method} ${request.url} not found`;
    return reply.code(404).send(envelope('NOT_FOUND', message));
  });
}
