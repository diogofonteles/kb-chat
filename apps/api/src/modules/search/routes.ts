import {
  searchRequestSchema,
  searchResponseSchema,
  topicFacetsSchema,
  topicSlugSchema,
} from '@kb-chat/contracts';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  canSee,
  hasFeature,
  viewerOf,
  type RouteAccess,
} from '../auth/index.js';
import type { SearchService } from './search-service.js';
import type {
  MediaReport,
  SearchViewer,
  SearchWithMedia,
} from './search-with-media.js';

/** Searching a collection needs the collection and "Buscar documentos" (KBC-010). */
const SEARCH_ACCESS: RouteAccess = { topicParam: 'topic', feature: 'search' };

export interface SearchRouteOptions {
  readonly service: SearchService;
  /** Texts and spoken passages together (KBC-039). */
  readonly combined: SearchWithMedia;
  /** Requests per minute per client (ND-22); requires @fastify/rate-limit on the root. */
  readonly ratePerMinute: number;
}

/** Spoken passages only for whoever may listen, in the collections they see. */
const searchViewerOf = (request: FastifyRequest): SearchViewer => ({
  mayHear: hasFeature(viewerOf(request).person, 'media'),
  canSee: (topic) => canSee(request, topic),
});

/** The media query's time apart from the search's (ADR 0024: p95 ≤ 150 ms). */
function logMedia(request: FastifyRequest, entry: MediaReport): void {
  if (entry.mediaError !== undefined)
    request.log.warn(
      { err: entry.mediaError, mediaMs: entry.mediaMs },
      'media search failed; texts only',
    );
  else request.log.debug({ ...entry }, 'media search');
}

const topicParams = z.object({ topic: topicSlugSchema });

/** POST …/searches: texts and spoken passages (KBC-039). */
function registerSearch(
  app: FastifyInstance,
  { combined, ratePerMinute }: SearchRouteOptions,
): void {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/topics/:topic/searches',
    {
      config: {
        access: SEARCH_ACCESS,
        rateLimit: { max: ratePerMinute, timeWindow: '1 minute' },
      },
      schema: {
        params: topicParams,
        body: searchRequestSchema,
        response: { 200: searchResponseSchema },
      },
    },
    async (request) =>
      combined.search(request.params.topic, request.body, {
        viewer: searchViewerOf(request),
        report: (entry) => logMedia(request, entry),
      }),
  );
}

export const searchRoutes =
  (options: SearchRouteOptions): FastifyPluginAsync =>
  async (app) => {
    registerSearch(app, options);
    app.withTypeProvider<ZodTypeProvider>().get(
      '/api/v1/topics/:topic/facets',
      {
        config: { access: SEARCH_ACCESS },
        schema: {
          params: topicParams,
          response: { 200: topicFacetsSchema },
        },
      },
      async (request) => options.service.topicFacets(request.params.topic),
    );
  };
