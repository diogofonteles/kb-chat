import { spendTodaySchema } from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { SIGNED_IN, principalOf } from '../auth/index.js';
import type { SpendService } from './spend-service.js';

export const spendRoutes =
  (serviceFor: (principal: string) => SpendService): FastifyPluginAsync =>
  async (app) => {
    app.withTypeProvider<ZodTypeProvider>().get(
      '/api/v1/spend/today',
      {
        config: { access: SIGNED_IN },
        schema: { response: { 200: spendTodaySchema } },
      },
      async (request) => serviceFor(principalOf(request)).today(),
    );
  };
