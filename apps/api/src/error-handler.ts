import type { ApiError } from '@kb-chat/contracts';
import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError } from './app-error.js';

const envelope = (
  code: ApiError['error']['code'],
  message: string,
  details?: unknown,
): ApiError => ({
  error: details === undefined ? { code, message } : { code, message, details },
});

/** Single root handler: domain errors keep their code, validation is 400, the rest is 500. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError, request, reply) => {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) request.log.error({ err }, 'request failed');
      return reply
        .code(err.statusCode)
        .send(envelope(err.code, err.message, err.details));
    }
    if (hasZodFastifySchemaValidationErrors(err) || err.validation) {
      return reply
        .code(400)
        .send(envelope('VALIDATION_FAILED', 'Invalid request', err.validation));
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply
        .code(err.statusCode)
        .send(envelope('VALIDATION_FAILED', err.message));
    }
    request.log.error({ err }, 'unexpected error');
    return reply.code(500).send(envelope('INTERNAL', 'Unexpected error'));
  });
}
