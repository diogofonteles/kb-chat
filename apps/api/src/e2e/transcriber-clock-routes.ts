import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TranscriberStorePort } from '../ports/transcriber-store.js';
import { PUBLIC } from '../modules/auth/index.js';

const bodySchema = z.object({
  id: z.string().min(1),
  hoursAgo: z.number().min(0).max(48),
});

/**
 * The E2E server only (KBC-036 AC-2): this transcriber was last seen `hoursAgo`, as if the
 * Mac had been off since then. One, by id: specs run side by side. Never part of main.
 */
export function registerTranscriberClock(
  app: FastifyInstance,
  transcribers: TranscriberStorePort,
): void {
  app.post(
    '/api/e2e/transcribers/last-seen',
    { config: { access: PUBLIC } },
    async (request, reply) => {
      const { id, hoursAgo } = bodySchema.parse(request.body);
      transcribers.touch({
        id,
        now: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
      });
      return reply.code(204).send();
    },
  );
}
