import {
  searchRequestSchema,
  searchResponseSchema,
  topicSlugSchema,
} from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { SearchService } from './search-service.js';

export const searchRoutes =
  (service: SearchService): FastifyPluginAsync =>
  async (app) => {
    app.withTypeProvider<ZodTypeProvider>().post(
      '/api/v1/topics/:topic/searches',
      {
        schema: {
          params: z.object({ topic: topicSlugSchema }),
          body: searchRequestSchema,
          response: { 200: searchResponseSchema },
        },
      },
      async (request) => service.search(request.params.topic, request.body),
    );
  };
