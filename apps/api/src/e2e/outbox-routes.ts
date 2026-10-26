import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MemoryOutbox } from '../adapters/memory-outbox.js';
import { PUBLIC } from '../modules/auth/index.js';

const querySchema = z.object({ to: z.string().min(3).max(254) });

/**
 * The E2E server's mailbox (KBC-014): what was "sent" to an address, newest last, so a
 * spec can read the one-time code. Never part of main (route-access.test.ts checks it).
 */
export function registerOutbox(
  app: FastifyInstance,
  outbox: MemoryOutbox,
): void {
  app.get(
    '/api/e2e/outbox',
    { config: { access: PUBLIC } },
    async (request) => {
      const { to } = querySchema.parse(request.query);
      return { items: outbox.to(to) };
    },
  );
}
