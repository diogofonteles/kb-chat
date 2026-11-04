import {
  confirmVoicesRequestSchema,
  diarizeRequestSchema,
  mediaIdSchema,
  mediaSpeakersSchema,
  mergeVoicesRequestSchema,
  nameVoiceRequestSchema,
  splitVoiceRequestSchema,
  voiceIndexSchema,
} from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertFeature, type RouteAccess } from '../auth/index.js';
import type { DiarizationService } from './diarization-service.js';
import { actorOf } from './routes.js';
import type { VoiceNamesService } from './voice-names-service.js';

/**
 * Voices are for whoever edits recordings and may listen to them (KBC-064 BR-2, FR-4):
 * `media-edit` by the route, `media` by the hook below; masters have both.
 */
const EDIT: RouteAccess = { feature: 'media-edit' };
const mediaParams = z.object({ id: mediaIdSchema });
const voiceParams = z.object({
  id: mediaIdSchema,
  voice: z.coerce.number().pipe(voiceIndexSchema),
});
const changed = { 200: mediaSpeakersSchema };
const change = <Body>(body: Body) => ({
  config: { access: EDIT },
  schema: { params: mediaParams, body, response: changed },
});

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
  name: {
    config: { access: EDIT },
    schema: {
      params: voiceParams,
      body: nameVoiceRequestSchema,
      response: changed,
    },
  },
  merge: change(mergeVoicesRequestSchema),
  split: change(splitVoiceRequestSchema),
  confirm: change(confirmVoicesRequestSchema),
} as const;

/** "Separar vozes", the voices found and who they are (KBC-064, KBC-065 FR-2). */
export const speakerRoutes =
  (service: DiarizationService, names: VoiceNamesService): FastifyPluginAsync =>
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
    typed.put('/api/v1/media/:id/voices/:voice', OPTIONS.name, (request) =>
      Promise.resolve(
        names.name(
          actorOf(request),
          { mediaId: request.params.id, voice: request.params.voice },
          request.body,
        ),
      ),
    );
    typed.post('/api/v1/media/:id/voices/merge', OPTIONS.merge, (request) =>
      Promise.resolve(
        names.merge(actorOf(request), request.params.id, request.body),
      ),
    );
    typed.post('/api/v1/media/:id/voices/split', OPTIONS.split, (request) =>
      Promise.resolve(
        names.split(actorOf(request), request.params.id, request.body),
      ),
    );
    typed.post('/api/v1/media/:id/voices/confirm', OPTIONS.confirm, (request) =>
      Promise.resolve(
        names.confirm(actorOf(request), request.params.id, request.body),
      ),
    );
  };
