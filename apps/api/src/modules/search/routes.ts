import {
  searchRequestSchema,
  searchResponseSchema,
  topicFacetsSchema,
  topicSlugSchema,
} from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { SearchService } from './search-service.js';

export interface SearchRouteOptions {
  readonly service: SearchService;
  /** Requests per minute per client (ND-22); requires @fastify/rate-limit on the root. */
  readonly ratePerMinute: number;
}

export const searchRoutes =
  ({ service, ratePerMinute }: SearchRouteOptions): FastifyPluginAsync =>
  async (app) => {
    app.withTypeProvider<ZodTypeProvider>().post(
      '/api/v1/topics/:topic/searches',
      {
        config: { rateLimit: { max: ratePerMinute, timeWindow: '1 minute' } },
        schema: {
          params: z.object({ topic: topicSlugSchema }),
          body: searchRequestSchema,
          response: { 200: searchResponseSchema },
        },
      },
      async (request) => service.search(request.params.topic, request.body),
    );
    app.withTypeProvider<ZodTypeProvider>().get(
      '/api/v1/topics/:topic/facets',
      {
        schema: {
          params: z.object({ topic: topicSlugSchema }),
          response: { 200: topicFacetsSchema },
        },
      },
      async (request) => service.topicFacets(request.params.topic),
    );
  };
