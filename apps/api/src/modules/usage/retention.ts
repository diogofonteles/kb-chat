import type { FastifyBaseLogger } from 'fastify';
import type { UsageLogPort } from '../../ports/usage-log.js';

/** Usage events older than this are removed when the API starts (KBC-006 BR-3). */
export const USAGE_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

/**
 * Applies the retention before the API listens. A failure only warns: the local usage log
 * is a measurement aid and must never keep the app from starting.
 */
export async function applyUsageRetention(
  log: UsageLogPort,
  logger: Pick<FastifyBaseLogger, 'info' | 'warn'>,
  now = new Date(),
): Promise<number> {
  try {
    const removed = await log.prune(
      new Date(now.getTime() - USAGE_RETENTION_DAYS * DAY_MS),
    );
    if (removed > 0) logger.info({ removed }, 'usage log retention applied');
    return removed;
  } catch (err) {
    logger.warn({ err }, 'usage log retention failed');
    return 0;
  }
}
