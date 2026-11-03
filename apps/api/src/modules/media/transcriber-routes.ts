import {
  mediaIdSchema,
  mediaItemSchema,
  pairTranscriberRequestSchema,
  pairedTranscriberSchema,
  transcriberIdSchema,
  transcriberListSchema,
} from '@kb-chat/contracts';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { principalOf, type RouteAccess } from '../auth/index.js';
import type { MediaService } from './media-service.js';
import { actorOf } from './routes.js';
import type { TranscriberService } from './transcriber-service.js';

/** BR-1: only masters pair, list and revoke transcribers. */
const MASTER: RouteAccess = { master: true };

const OPTIONS = {
  list: {
    config: { access: MASTER },
    schema: { response: { 200: transcriberListSchema } },
  },
  pair: {
    config: { access: MASTER },
    schema: {
      body: pairTranscriberRequestSchema,
      response: { 201: pairedTranscriberSchema },
    },
  },
  revoke: {
    config: { access: MASTER },
    schema: {
      params: z.object({ id: transcriberIdSchema }),
      response: { 204: z.undefined() },
    },
  },
  again: {
    config: { access: MASTER },
    schema: {
      params: z.object({ id: mediaIdSchema }),
      response: { 200: mediaItemSchema },
    },
  },
} as const;

interface TranscriberRouteDeps {
  readonly transcribers: TranscriberService;
  readonly media: MediaService;
}

/**
 * "Transcritores" (KBC-036 FR-5) and a master's "transcribe again" (BR-3). Pairing answers
 * the token this one time; the API keeps only its keyed hash.
 */
export const transcriberRoutes =
  (deps: TranscriberRouteDeps): FastifyPluginAsync =>
  async (app) => {
    registerPairing(app, deps.transcribers);
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.delete(
      '/api/v1/media/transcribers/:id',
      OPTIONS.revoke,
      async (request, reply) => {
        deps.transcribers.revoke(request.params.id);
        return reply.code(204).send();
      },
    );
    typed.post(
      '/api/v1/media/:id/transcription',
      OPTIONS.again,
      async (request) =>
        deps.media.transcribeAgain(actorOf(request), request.params.id),
    );
  };

function registerPairing(
  app: FastifyInstance,
  transcribers: TranscriberService,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get('/api/v1/media/transcribers', OPTIONS.list, async () => ({
    items: transcribers.list(),
  }));
  typed.post(
    '/api/v1/media/transcribers',
    OPTIONS.pair,
    async (request, reply) => {
      const paired = transcribers.pair({
        name: request.body.name,
        pairedBy: principalOf(request),
      });
      return reply.code(201).send(paired);
    },
  );
}
