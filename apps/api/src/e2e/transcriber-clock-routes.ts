import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TranscriberStorePort } from '../ports/transcriber-store.js';
import { PUBLIC } from '../modules/auth/index.js';

const bodySchema = z.object({ hoursAgo: z.number().min(0).max(48) });

/**
 * The E2E server only (KBC-036 AC-2): every paired transcriber was last seen `hoursAgo`,
 * as if the Mac had been off since then. Never part of main.
 */
export function registerTranscriberClock(
  app: FastifyInstance,
  transcribers: TranscriberStorePort,
): void {
  app.post(
    '/api/e2e/transcribers/last-seen',
    { config: { access: PUBLIC } },
    async (request, reply) => {
      const { hoursAgo } = bodySchema.parse(request.body);
      const now = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
      for (const one of transcribers.list())
        transcribers.touch({ id: one.id, now });
      return reply.code(204).send();
    },
  );
}
