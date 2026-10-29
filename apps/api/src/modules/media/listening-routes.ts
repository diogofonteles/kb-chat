import {
  mediaIdSchema,
  mediaPreferencesSchema,
  mediaProgressRequestSchema,
} from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteAccess } from '../auth/index.js';
import type { ListeningService } from './listening-service.js';
import { actorOf } from './routes.js';

/** Part of listening: the `media` feature, as the stream (KBC-041 FR-1, FR-2). */
const LISTEN: RouteAccess = { feature: 'media' };

/** Route options, declared once: access (ADR 0008) and contract schemas (ND-08). */
const OPTIONS = {
  preferences: {
    config: { access: LISTEN },
    schema: { response: { 200: mediaPreferencesSchema } },
  },
  savePreferences: {
    config: { access: LISTEN },
    schema: {
      body: mediaPreferencesSchema,
      response: { 200: mediaPreferencesSchema },
    },
  },
  progress: {
    config: { access: LISTEN },
    schema: {
      params: z.object({ id: mediaIdSchema }),
      body: mediaProgressRequestSchema,
    },
  },
} as const;

/** Each person's preferences and positions (KBC-041). */
export const listeningRoutes =
  (service: ListeningService): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get('/api/v1/media/preferences', OPTIONS.preferences, (request) =>
      service.preferences(actorOf(request)),
    );
    typed.put('/api/v1/media/preferences', OPTIONS.savePreferences, (request) =>
      service.savePreferences(actorOf(request), request.body),
    );
    typed.put(
      '/api/v1/media/:id/progress',
      OPTIONS.progress,
      async (request, reply) => {
        service.saveProgress(
          actorOf(request),
          request.params.id,
          request.body.positionMs,
        );
        return reply.code(204).send();
      },
    );
  };
