import {
  createMediaBookmarkRequestSchema,
  mediaBookmarkIdSchema,
  mediaBookmarkListSchema,
  mediaBookmarkSchema,
  mediaIdSchema,
  myMediaBookmarkListSchema,
  updateMediaBookmarkRequestSchema,
} from '@kb-chat/contracts';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteAccess } from '../auth/index.js';
import type { BookmarkService } from './bookmark-service.js';
import { actorOf } from './routes.js';

/** Part of listening: the `media` feature, as the stream (KBC-042 FR-1). */
const LISTEN: RouteAccess = { feature: 'media' };

const media = z.object({ id: mediaIdSchema });
const oneBookmark = z.object({
  id: mediaIdSchema,
  bookmarkId: mediaBookmarkIdSchema,
});

/** Route options, declared once: access (ADR 0008) and contract schemas (ND-08). */
const OPTIONS = {
  mine: {
    config: { access: LISTEN },
    schema: { response: { 200: myMediaBookmarkListSchema } },
  },
  list: {
    config: { access: LISTEN },
    schema: { params: media, response: { 200: mediaBookmarkListSchema } },
  },
  create: {
    config: { access: LISTEN },
    schema: {
      params: media,
      body: createMediaBookmarkRequestSchema,
      response: { 200: mediaBookmarkSchema, 201: mediaBookmarkSchema },
    },
  },
  update: {
    config: { access: LISTEN },
    schema: {
      params: oneBookmark,
      body: updateMediaBookmarkRequestSchema,
      response: { 200: mediaBookmarkSchema },
    },
  },
  remove: {
    config: { access: LISTEN },
    schema: { params: oneBookmark, response: { 204: z.undefined() } },
  },
} as const;

/** The person's bookmarks in one media, and in every media (FR-1, FR-5). */
function registerReads(app: FastifyInstance, service: BookmarkService): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get('/api/v1/media/bookmarks', OPTIONS.mine, (request) => ({
    items: service.mine(actorOf(request)),
  }));
  typed.get('/api/v1/media/:id/bookmarks', OPTIONS.list, (request) => ({
    items: service.list(actorOf(request), request.params.id),
  }));
}

/** Create, idempotent by the client's id (FR-1). */
function registerCreate(app: FastifyInstance, service: BookmarkService): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/media/:id/bookmarks',
    OPTIONS.create,
    async (request, reply) => {
      const { bookmark, created } = service.create(
        actorOf(request),
        request.params.id,
        request.body,
      );
      return reply.code(created ? 201 : 200).send(bookmark);
    },
  );
}

/** Edit the note, delete (FR-1). */
function registerChanges(app: FastifyInstance, service: BookmarkService): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.patch(
    '/api/v1/media/:id/bookmarks/:bookmarkId',
    OPTIONS.update,
    (request) =>
      service.updateNote(
        actorOf(request),
        { mediaId: request.params.id, id: request.params.bookmarkId },
        request.body.note,
      ),
  );
  typed.delete(
    '/api/v1/media/:id/bookmarks/:bookmarkId',
    OPTIONS.remove,
    async (request, reply) => {
      service.remove(actorOf(request), {
        mediaId: request.params.id,
        id: request.params.bookmarkId,
      });
      return reply.code(204).send();
    },
  );
}

/** Each person's bookmarks (KBC-042). */
export const bookmarkRoutes =
  (service: BookmarkService): FastifyPluginAsync =>
  async (app) => {
    registerReads(app, service);
    registerCreate(app, service);
    registerChanges(app, service);
  };
