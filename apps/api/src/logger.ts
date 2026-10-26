import type { FastifyBaseLogger } from 'fastify';
import { pino, type DestinationStream, type LoggerOptions } from 'pino';
import type { AppConfig } from './config.js';

/** One pino instance for the app and the adapters, with secrets redacted (ND-14). */
export function createLogger(
  level: AppConfig['LOG_LEVEL'],
  destination?: DestinationStream,
): FastifyBaseLogger {
  const options: LoggerOptions = {
    level,
    redact: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      '*.apiKey',
      '*.key',
      '*.keys',
      '*.token',
      '*.OPENROUTER_API_KEY',
      '*.ANTHROPIC_API_KEY',
      '*.OPENAI_API_KEY',
    ],
  };
  return destination ? pino(options, destination) : pino(options);
}
