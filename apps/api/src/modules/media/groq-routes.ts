import {
  groqModeRequestSchema,
  groqSettingsSchema,
  groqTestRequestSchema,
  groqTestResultSchema,
  mediaIdSchema,
  mediaItemSchema,
  mediaSpendCapRequestSchema,
} from '@kb-chat/contracts';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import { principalOf, viewerOf, type RouteAccess } from '../auth/index.js';
import type { GroqService } from './groq-service.js';
import type { MediaService } from './media-service.js';
import { actorOf } from './routes.js';

/** BR-1: masters connect Groq and choose when it runs; never a master acting as someone. */
const MASTER: RouteAccess = { master: true };
const MASTER_WRITE: RouteAccess = { master: true, notWhileActing: true };

const OPTIONS = {
  view: {
    config: { access: MASTER },
    schema: { response: { 200: groqSettingsSchema } },
  },
  test: {
    config: { access: MASTER_WRITE },
    schema: {
      body: groqTestRequestSchema,
      response: { 200: groqTestResultSchema },
    },
  },
  removeKey: {
    config: { access: MASTER_WRITE },
    schema: { response: { 200: groqSettingsSchema } },
  },
  mode: {
    config: { access: MASTER_WRITE },
    schema: {
      body: groqModeRequestSchema,
      response: { 200: groqSettingsSchema },
    },
  },
  cap: {
    config: { access: MASTER_WRITE },
    schema: {
      body: mediaSpendCapRequestSchema,
      response: { 200: groqSettingsSchema },
    },
  },
  send: {
    config: { access: MASTER_WRITE },
    schema: {
      params: z.object({ id: mediaIdSchema }),
      response: { 200: mediaItemSchema },
    },
  },
} as const;

const isOwner = (request: FastifyRequest): boolean => viewerOf(request).isOwner;

/**
 * "Groq de reserva" (KBC-037): connect the key, choose the mode, see the month's media
 * spend and, for the owner, its cap; and "Transcrever com Groq" on one item.
 */
export const groqRoutes =
  (deps: {
    readonly groq: GroqService;
    readonly media: MediaService;
  }): FastifyPluginAsync =>
  async (app) => {
    registerConnection(app, deps.groq);
    registerChoices(app, deps.groq);
    registerSend(app, deps);
  };

/** The view and the key (FR-1, BR-3). */
function registerConnection(app: FastifyInstance, groq: GroqService): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get('/api/v1/media/groq', OPTIONS.view, async (request) =>
    groq.view(isOwner(request)),
  );
  typed.post('/api/v1/media/groq/test', OPTIONS.test, async (request) =>
    groq.test(
      { key: request.body.key, by: principalOf(request) },
      isOwner(request),
    ),
  );
  typed.delete('/api/v1/media/groq/key', OPTIONS.removeKey, async (request) => {
    groq.removeKey(principalOf(request));
    return groq.view(isOwner(request));
  });
}

/** The mode (BR-1, FR-2) and the owner's cap (BR-2). */
function registerChoices(app: FastifyInstance, groq: GroqService): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.put('/api/v1/media/groq/mode', OPTIONS.mode, async (request) => {
    groq.setMode(request.body, principalOf(request));
    return groq.view(isOwner(request));
  });
  typed.put('/api/v1/media/spend-cap', OPTIONS.cap, async (request) => {
    // BR-2: the owner edits the cap; other masters only see it.
    if (!isOwner(request))
      throw new AppError('FORBIDDEN', 'Only the owner sets the media cap');
    groq.setCap(request.body.capUsd, principalOf(request));
    return groq.view(true);
  });
}

/** "Transcrever com Groq": one item's waiting transcription goes to Groq. */
function registerSend(
  app: FastifyInstance,
  { groq, media }: { groq: GroqService; media: MediaService },
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/media/:id/transcription/groq',
    OPTIONS.send,
    async (request) => {
      const actor = actorOf(request);
      // Visibility first: an item the master cannot see is 404 like any other.
      media.get(actor, request.params.id);
      groq.sendItem(request.params.id);
      return media.get(actor, request.params.id);
    },
  );
}
