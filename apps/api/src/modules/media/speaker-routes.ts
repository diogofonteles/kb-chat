import {
  confirmVoicesRequestSchema,
  decideVoiceSuggestionRequestSchema,
  diarizeRequestSchema,
  mediaIdSchema,
  mediaSpeakersSchema,
  mergeVoicesRequestSchema,
  nameVoiceRequestSchema,
  refuseVoiceNameRequestSchema,
  splitVoiceRequestSchema,
  voiceIndexSchema,
} from '@kb-chat/contracts';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyPluginAsync,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertFeature, type RouteAccess } from '../auth/index.js';
import type { DiarizationService } from './diarization-service.js';
import { actorOf } from './routes.js';
import type { VoiceNamesService } from './voice-names-service.js';
import type { VoiceSuggestionService } from './voice-suggestion-service.js';

type Typed = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

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
  refuseName: {
    config: { access: EDIT },
    schema: {
      params: voiceParams,
      body: refuseVoiceNameRequestSchema,
      response: changed,
    },
  },
  suggestion: {
    config: { access: EDIT },
    schema: {
      params: voiceParams,
      body: decideVoiceSuggestionRequestSchema,
      response: changed,
    },
  },
  merge: change(mergeVoicesRequestSchema),
  split: change(splitVoiceRequestSchema),
  confirm: change(confirmVoicesRequestSchema),
} as const;

/** "Separar vozes" and the voices found (KBC-064 FR-1, FR-4). */
function registerSeparation(typed: Typed, service: DiarizationService): void {
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
}

/** Who the voices are (KBC-065 FR-2, FR-5). */
function registerNames(typed: Typed, names: VoiceNamesService): void {
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
}

/** The name suggested is not the voice's (KBC-090). */
function registerRefusal(typed: Typed, names: VoiceNamesService): void {
  typed.post(
    '/api/v1/media/:id/voices/:voice/refuse-name',
    OPTIONS.refuseName,
    (request) =>
      Promise.resolve(
        names.refuseName(
          actorOf(request),
          { mediaId: request.params.id, voice: request.params.voice },
          request.body,
        ),
      ),
  );
}

/** A person's answer to "parece ser" (KBC-071 AC-2). */
function registerSuggestions(
  typed: Typed,
  suggestions: VoiceSuggestionService,
): void {
  typed.post(
    '/api/v1/media/:id/voices/:voice/suggestion',
    OPTIONS.suggestion,
    (request) =>
      Promise.resolve(
        suggestions.decide(
          actorOf(request),
          { mediaId: request.params.id, voice: request.params.voice },
          request.body,
        ),
      ),
  );
}

export interface SpeakerRoutesDeps {
  readonly service: DiarizationService;
  readonly names: VoiceNamesService;
  readonly suggestions: VoiceSuggestionService;
}

/** "Vozes": the separation and who each voice is. */
export const speakerRoutes =
  ({ service, names, suggestions }: SpeakerRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', async (request) =>
      assertFeature(request, 'media'),
    );
    const typed = app.withTypeProvider<ZodTypeProvider>();
    registerSeparation(typed, service);
    registerNames(typed, names);
    registerRefusal(typed, names);
    registerSuggestions(typed, suggestions);
  };
