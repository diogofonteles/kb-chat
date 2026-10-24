import { spendTodaySchema } from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { SpendService } from './spend-service.js';

export const spendRoutes =
  (service: SpendService): FastifyPluginAsync =>
  async (app) => {
    app
      .withTypeProvider<ZodTypeProvider>()
      .get(
        '/api/v1/spend/today',
        { schema: { response: { 200: spendTodaySchema } } },
        async () => service.today(),
      );
  };
