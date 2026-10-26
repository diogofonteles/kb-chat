import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PUBLIC } from '../modules/auth/index.js';
import type { FakeOpenRouter } from '../testing/fake-openrouter.js';

/** The fake consent page's address on the E2E server (KBC-022). */
export const E2E_AUTHORIZE_PATH = '/api/e2e/openrouter/auth';

const querySchema = z.object({
  callback_url: z.url(),
  code_challenge: z.string().min(1),
  state: z.string().min(1),
});

/**
 * OpenRouter's consent page, approved at once: back to the callback with a code for this
 * challenge, as OpenRouter does after "Authorize". Never part of main.
 */
export function registerOpenRouterConsent(
  app: FastifyInstance,
  fake: FakeOpenRouter,
): void {
  app.get(
    E2E_AUTHORIZE_PATH,
    { config: { access: PUBLIC } },
    async (request, reply) => {
      const query = querySchema.parse(request.query);
      const back = new URL(query.callback_url);
      back.searchParams.set(
        'code',
        fake.authorize(query.code_challenge, 'sk-or-v1-e2e-house-wxyz'),
      );
      back.searchParams.set('state', query.state);
      return reply.redirect(back.toString(), 303);
    },
  );
}
