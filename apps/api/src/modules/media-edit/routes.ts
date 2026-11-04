import {
  editApprovedSchema,
  editSavedSchema,
  editWordsSchema,
  mediaEditSchema,
  mediaIdSchema,
  mediaTracksSchema,
  saveEditRequestSchema,
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
import { AppError } from '../../app-error.js';
import { assertFeature, type RouteAccess } from '../auth/index.js';
import { actorOf } from '../media/index.js';
import type { EditCall, TrackEditService } from './track-edit-service.js';

/** Editing is `media-edit`, on top of `media` as every other media route (BR-8). */
type TypedRoutes = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

const EDIT: RouteAccess = { feature: 'media-edit' };
const NAVIGATE: RouteAccess = { feature: 'media-tracks' };
const mediaParams = z.object({ id: mediaIdSchema });
const ETAG = /^"(\d+)"$/;

const editSchema = {
  params: mediaParams,
  response: { 200: editSavedSchema },
};

const OPTIONS = {
  read: {
    config: { access: EDIT },
    schema: { params: mediaParams, response: { 200: mediaEditSchema } },
  },
  save: {
    config: { access: EDIT },
    schema: { ...editSchema, body: saveEditRequestSchema },
  },
  approve: {
    config: { access: EDIT },
    schema: { params: mediaParams, response: { 200: editApprovedSchema } },
  },
  reopen: { config: { access: EDIT }, schema: editSchema },
  retryCuts: { config: { access: EDIT }, schema: editSchema },
  words: {
    config: { access: EDIT },
    schema: { params: mediaParams, response: { 200: editWordsSchema } },
  },
  tracks: {
    config: { access: NAVIGATE },
    schema: { params: mediaParams, response: { 200: mediaTracksSchema } },
  },
} as const;

/** The version a write says it read (FR-1): a write without one is refused (428). */
function versionOf(request: FastifyRequest): number {
  const match = ETAG.exec(request.headers['if-match'] ?? '');
  if (!match?.[1])
    throw new AppError('EDIT_VERSION_REQUIRED', 'If-Match is required');
  return Number(match[1]);
}

/** The person, the media and the version of a write. */
function callOf(request: FastifyRequest, mediaId: string): EditCall {
  return {
    actor: actorOf(request),
    mediaId,
    expectedVersion: versionOf(request),
  };
}

/** Reopening, and "Tentar de novo" for cuts given up (KBC-068 FR-1). */
function registerAfterApproval(
  typed: TypedRoutes,
  service: TrackEditService,
): void {
  typed.post('/api/v1/media/:id/edit/reopen', OPTIONS.reopen, (request) =>
    service.reopen(callOf(request, request.params.id)),
  );
  typed.post(
    '/api/v1/media/:id/edit/retry-cuts',
    OPTIONS.retryCuts,
    async (request) => service.retryCuts(callOf(request, request.params.id)),
  );
}

/** The draft and its approval (KBC-066 FR-1, FR-2) and the approved tracks. */
export const mediaEditRoutes =
  (service: TrackEditService): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', async (request) => {
      assertFeature(request, 'media');
    });
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get(
      '/api/v1/media/:id/edit',
      OPTIONS.read,
      async (request, reply) => {
        const edit = service.get(actorOf(request), request.params.id);
        return reply.header('etag', `"${edit.version}"`).send(edit);
      },
    );
    typed.put('/api/v1/media/:id/edit', OPTIONS.save, (request) =>
      service.save(callOf(request, request.params.id), request.body),
    );
    typed.post('/api/v1/media/:id/edit/approve', OPTIONS.approve, (request) =>
      service.approve(callOf(request, request.params.id)),
    );
    registerAfterApproval(typed, service);
    typed.get('/api/v1/media/:id/edit/words', OPTIONS.words, (request) =>
      service.words(actorOf(request), request.params.id),
    );
    typed.get('/api/v1/media/:id/tracks', OPTIONS.tracks, (request) =>
      service.tracks(actorOf(request), request.params.id),
    );
  };
