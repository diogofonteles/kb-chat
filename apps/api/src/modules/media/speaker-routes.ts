import {
  diarizeRequestSchema,
  mediaIdSchema,
  mediaSpeakersSchema,
} from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertFeature, type RouteAccess } from '../auth/index.js';
import type { DiarizationService } from './diarization-service.js';
import { actorOf } from './routes.js';

/**
 * Voices are for whoever edits recordings and may listen to them (KBC-064 BR-2, FR-4):
 * `media-edit` by the route, `media` by the hook below; masters have both.
 */
const EDIT: RouteAccess = { feature: 'media-edit' };
const mediaParams = z.object({ id: mediaIdSchema });

const OPTIONS = {
  speakers: {
    config: { access: EDIT },
    schema: { params: mediaParams, response: { 200: mediaSpeakersSchema } },
  },
  diarize: {
    config: { access: EDIT },
    schema: {
      params: mediaParams,
      body: diarizeRequestSchema,
      response: { 202: mediaSpeakersSchema },
    },
  },
} as const;

/** "Separar vozes" and the voices found (KBC-064 FR-1, FR-4). */
export const speakerRoutes =
  (service: DiarizationService): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', async (request) =>
      assertFeature(request, 'media'),
    );
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get('/api/v1/media/:id/speakers', OPTIONS.speakers, (request) =>
      Promise.resolve(service.speakers(actorOf(request), request.params.id)),
    );
    typed.post(
      '/api/v1/media/:id/diarize',
      OPTIONS.diarize,
      async (request, reply) => {
        const queued = service.request(
          actorOf(request),
          request.params.id,
          request.body,
        );
        return reply.code(202).send(queued);
      },
    );
  };
