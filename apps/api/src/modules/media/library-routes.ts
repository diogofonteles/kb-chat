import {
  libraryHomeQuerySchema,
  libraryHomeSchema,
  libraryPageSchema,
  libraryQuerySchema,
  librarySearchQuerySchema,
  librarySearchSchema,
  markPlayedRequestSchema,
  markPlayedResultSchema,
} from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteAccess } from '../auth/index.js';
import type { LibraryService } from './library-service.js';
import { actorOf } from './routes.js';

/** "Biblioteca de mídia" needs "Ouvir mídia" as well (KBC-051 BR-1). */
const LIBRARY: RouteAccess = { feature: ['media', 'media-library'] };

/** Route options, declared once: access (ADR 0008) and contract schemas (ND-08). */
const OPTIONS = {
  page: {
    config: { access: LIBRARY },
    schema: {
      querystring: libraryQuerySchema,
      response: { 200: libraryPageSchema },
    },
  },
  home: {
    config: { access: LIBRARY },
    schema: {
      querystring: libraryHomeQuerySchema,
      response: { 200: libraryHomeSchema },
    },
  },
  clearRecents: {
    config: { access: LIBRARY },
    schema: { response: { 204: z.undefined() } },
  },
  played: {
    config: { access: LIBRARY },
    schema: {
      body: markPlayedRequestSchema,
      response: { 200: markPlayedResultSchema },
    },
  },
} as const;

/** A search per pause in the typing: a minute of it, not a script (ND-22). */
const searchOptions = (perMinute: number) =>
  ({
    config: {
      access: LIBRARY,
      rateLimit: { max: perMinute, timeWindow: '1 minute' },
    },
    schema: {
      querystring: librarySearchQuerySchema,
      response: { 200: librarySearchSchema },
    },
  }) as const;

/** The media library (KBC-051 FR-1 to FR-4, screens.md T16). */
export const libraryRoutes =
  (service: LibraryService, searchesPerMinute: number): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get('/api/v1/media/library', OPTIONS.page, async (request) =>
      service.page(actorOf(request), request.query),
    );
    typed.get(
      '/api/v1/media/library/search',
      searchOptions(searchesPerMinute),
      async (request) => service.search(actorOf(request), request.query),
    );
    typed.get('/api/v1/media/library/home', OPTIONS.home, async (request) =>
      service.home(actorOf(request), request.query.topic),
    );
    typed.delete(
      '/api/v1/media/library/recents',
      OPTIONS.clearRecents,
      async (request, reply) => {
        service.clearRecents(actorOf(request));
        return reply.code(204).send();
      },
    );
    typed.put('/api/v1/media/played', OPTIONS.played, async (request) =>
      service.markPlayed(actorOf(request), request.body),
    );
  };
