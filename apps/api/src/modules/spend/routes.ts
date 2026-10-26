import { spendByPersonSchema, spendTodaySchema } from '@kb-chat/contracts';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AppError } from '../../app-error.js';
import type { SpendLedgerPort } from '../../ports/spend-ledger.js';
import { SIGNED_IN, principalOf, viewerOf } from '../auth/index.js';
import type { SpendService } from './spend-service.js';

/** Whose spend the owner sees: every person who signed in, with their principal. */
export interface SpendPerson {
  readonly email: string;
  readonly principal: string;
}

export interface SpendRouteDeps {
  readonly serviceFor: (principal: string) => SpendService;
  readonly ledger: SpendLedgerPort;
  readonly people: () => Promise<readonly SpendPerson[]>;
}

function registerToday(app: FastifyInstance, { serviceFor }: SpendRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/v1/spend/today',
    {
      config: { access: SIGNED_IN },
      schema: { response: { 200: spendTodaySchema } },
    },
    async (request) => serviceFor(principalOf(request)).today(),
  );
}

/** The owner sees each person's spend, never their content (KBC-010 BR-6). */
function registerByPerson(app: FastifyInstance, deps: SpendRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/v1/spend/people',
    {
      config: { access: { master: true } },
      schema: { response: { 200: spendByPersonSchema } },
    },
    async (request) => {
      if (!viewerOf(request).isOwner)
        throw new AppError('FORBIDDEN', 'Only the owner sees spend per person');
      const people = await deps.people();
      const items = await Promise.all(
        people.map(async ({ email, principal }) => ({
          email,
          usd: await deps.ledger.spentToday(principal),
        })),
      );
      return { items };
    },
  );
}

export const spendRoutes =
  (deps: SpendRouteDeps): FastifyPluginAsync =>
  async (app) => {
    registerToday(app, deps);
    registerByPerson(app, deps);
  };
