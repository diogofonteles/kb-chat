import type { FastifyBaseLogger } from 'fastify';
import { pino } from 'pino';
import type { AppConfig } from './config.js';

/** One pino instance for the app and the adapters, with secrets redacted (ND-14). */
export function createLogger(level: AppConfig['LOG_LEVEL']): FastifyBaseLogger {
  return pino({
    level,
    redact: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.apiKey',
      '*.OPENROUTER_API_KEY',
    ],
  });
}
