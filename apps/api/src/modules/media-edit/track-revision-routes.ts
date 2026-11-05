import {
  archivedTracksSchema,
  mediaIdSchema,
  mediaItemSchema,
  movedBookmarksSchema,
  movedBookmarksSeenSchema,
  trackBoundsRequestSchema,
  trackEditViewSchema,
  trackHistorySchema,
  trackImpactSchema,
} from '@kb-chat/contracts';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertFeature, type RouteAccess } from '../auth/index.js';
import { actorOf, versionOf, type TrackCall } from '../media/index.js';
import type { TrackRevisionService } from './track-revision-service.js';

/** Editing a track is `media-edit`, the same right as editing it before (owner's default 8). */
const EDIT: RouteAccess = { feature: 'media-edit' };
const LISTEN: RouteAccess = { feature: 'media' };
const params = z.object({ id: mediaIdSchema });

const read = <Schema>(schema: Schema) => ({
  config: { access: EDIT },
  schema: { params, response: { 200: schema } },
});

const OPTIONS = {
  view: read(trackEditViewSchema),
  impact: read(trackImpactSchema),
  history: read(trackHistorySchema),
  archived: read(archivedTracksSchema),
  restore: read(mediaItemSchema),
  bounds: {
    config: { access: EDIT },
    schema: {
      params,
      body: trackBoundsRequestSchema,
      response: { 202: trackEditViewSchema },
    },
  },
  retry: {
    config: { access: EDIT },
    schema: { params, response: { 202: trackEditViewSchema } },
  },
  moved: {
    config: { access: LISTEN },
    schema: { response: { 200: movedBookmarksSchema } },
  },
  seen: {
    config: { access: LISTEN },
    schema: {
      body: movedBookmarksSeenSchema,
      response: { 204: z.undefined() },
    },
  },
} as const;

const callOf = (request: FastifyRequest, mediaId: string): TrackCall => ({
  actor: actorOf(request),
  mediaId,
  expectedVersion: versionOf(request),
});

type Typed = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

function registerReads(typed: Typed, service: TrackRevisionService): void {
  typed.get('/api/v1/media/:id/track-edit', OPTIONS.view, async (request) =>
    service.read(actorOf(request), request.params.id),
  );
  typed.get('/api/v1/media/:id/track-impact', OPTIONS.impact, async (request) =>
    service.impact(actorOf(request), request.params.id),
  );
  typed.get('/api/v1/media/:id/history', OPTIONS.history, async (request) =>
    service.history(actorOf(request), request.params.id),
  );
  typed.get(
    '/api/v1/media/:id/archived-tracks',
    OPTIONS.archived,
    async (request) => service.archived(actorOf(request), request.params.id),
  );
}

function registerWrites(typed: Typed, service: TrackRevisionService): void {
  typed.post('/api/v1/media/:id/restore', OPTIONS.restore, async (request) =>
    service.restore(actorOf(request), request.params.id),
  );
  typed.put(
    '/api/v1/media/:id/bounds',
    OPTIONS.bounds,
    async (request, reply) => {
      const call = callOf(request, request.params.id);
      return reply.code(202).send(service.bounds(call, request.body));
    },
  );
  typed.post(
    '/api/v1/media/:id/bounds/retry',
    OPTIONS.retry,
    async (request, reply) => {
      const call = callOf(request, request.params.id);
      return reply.code(202).send(service.retryCut(call));
    },
  );
}

/** "1 marcador foi movido": each person's, for all they see (BR-4). */
function registerMoved(typed: Typed, service: TrackRevisionService): void {
  typed.get('/api/v1/media/bookmarks/moved', OPTIONS.moved, async (request) =>
    service.movedBookmarks(actorOf(request)),
  );
  typed.post(
    '/api/v1/media/bookmarks/moved/seen',
    OPTIONS.seen,
    async (request, reply) => {
      service.acknowledgeMoved(actorOf(request), request.body.mediaId);
      return reply.code(204).send();
    },
  );
}

/** A track after its approval (KBC-073); PATCH and DELETE live on the item's own routes. */
export const trackRevisionRoutes =
  (service: TrackRevisionService): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', async (request) => {
      assertFeature(request, 'media');
    });
    const typed = app.withTypeProvider<ZodTypeProvider>();
    registerReads(typed, service);
    registerWrites(typed, service);
    registerMoved(typed, service);
  };
