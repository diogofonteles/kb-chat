import {
  changePreparationRequestSchema,
  mediaIdSchema,
  mediaPreparationSchema,
  openPreparationsSchema,
  preparationOptionsQuerySchema,
  preparationOptionsSchema,
  retryStageSchema,
  startPreparationRequestSchema,
} from '@kb-chat/contracts';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertFeature, type RouteAccess } from '../auth/index.js';
import { planActorOf } from '../media/index.js';
import type { PreparationService } from './preparation-service.js';

const LISTEN: RouteAccess = { feature: 'media' };
const EDIT: RouteAccess = { feature: 'media-edit' };
/** Retries a person may press per minute: one of them spends money (ND-22). */
const RETRIES_PER_MINUTE = 6;
const mediaParams = z.object({ id: mediaIdSchema });
const stepParams = z.object({ id: mediaIdSchema, step: retryStageSchema });
const preparationResponse = { 200: mediaPreparationSchema };

const OPTIONS = {
  options: {
    config: { access: LISTEN },
    schema: {
      querystring: preparationOptionsQuerySchema,
      response: { 200: preparationOptionsSchema },
    },
  },
  open: {
    config: { access: EDIT },
    schema: { response: { 200: openPreparationsSchema } },
  },
  read: {
    config: { access: EDIT },
    schema: { params: mediaParams, response: preparationResponse },
  },
  start: {
    config: { access: EDIT },
    schema: {
      params: mediaParams,
      body: startPreparationRequestSchema,
      response: preparationResponse,
    },
  },
  change: {
    config: { access: EDIT },
    schema: {
      params: mediaParams,
      body: changePreparationRequestSchema,
      response: preparationResponse,
    },
  },
  retry: {
    config: {
      access: EDIT,
      rateLimit: { max: RETRIES_PER_MINUTE, timeWindow: '1 minute' },
    },
    schema: { params: stepParams, response: preparationResponse },
  },
  next: {
    config: { access: EDIT },
    schema: { params: mediaParams, response: preparationResponse },
  },
} as const;

/** Reading where things stand (FR-2, FR-6, FR-7). */
function registerReads(app: FastifyInstance, service: PreparationService) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get('/api/v1/media/preparation-options', OPTIONS.options, (request) =>
    service.options(planActorOf(request), request.query),
  );
  typed.get('/api/v1/media/preparations', OPTIONS.open, async (request) =>
    service.listOpen(planActorOf(request)),
  );
  typed.get('/api/v1/media/:id/preparation', OPTIONS.read, (request) =>
    service.view(planActorOf(request), request.params.id),
  );
}

/** A person's moves (FR-4, FR-5, AC-16). */
function registerMoves(app: FastifyInstance, service: PreparationService) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post('/api/v1/media/:id/preparation', OPTIONS.start, (request) =>
    service.start(planActorOf(request), request.params.id, request.body.plan),
  );
  typed.patch('/api/v1/media/:id/preparation', OPTIONS.change, (request) =>
    service.switchToManual(planActorOf(request), request.params.id),
  );
  typed.post(
    '/api/v1/media/:id/preparation/steps/:step/retry',
    OPTIONS.retry,
    (request) =>
      service.retry(
        planActorOf(request),
        request.params.id,
        request.params.step,
      ),
  );
  typed.post('/api/v1/media/:id/preparation/advance', OPTIONS.next, (request) =>
    service.next(planActorOf(request), request.params.id),
  );
}

/** The guided flow's plan (KBC-072 FR-1 to FR-6), on top of `media` as every media route. */
export const preparationRoutes =
  (service: PreparationService): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', async (request) => {
      assertFeature(request, 'media');
    });
    registerReads(app, service);
    registerMoves(app, service);
  };
