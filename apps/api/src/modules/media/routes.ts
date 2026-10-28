import {
  createMediaRequestSchema,
  mediaIdSchema,
  mediaItemSchema,
  mediaListSchema,
  topicSlugSchema,
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
import { Readable } from 'node:stream';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import { canSee, isMaster, viewerOf, type RouteAccess } from '../auth/index.js';
import type { MediaActor, MediaService } from './media-service.js';
import { serveMedia } from './serve-media.js';

const SIGNED_IN: RouteAccess = {};
const UPLOAD: RouteAccess = { feature: 'media-upload' };
const MASTER: RouteAccess = { master: true };
const topicParams = z.object({ topic: topicSlugSchema });
const mediaParams = z.object({ id: mediaIdSchema });

/** The upload body: a stream only with `Content-Type: application/octet-stream`. */
function uploadBodyOf(body: unknown): Readable {
  if (body instanceof Readable) return body;
  throw new AppError(
    'VALIDATION_FAILED',
    'Send the file as application/octet-stream',
    {
      details: { field: 'file' },
    },
  );
}

/** The request's Content-Length, when the client sent one (chunked uploads do not). */
function declaredLengthOf(request: FastifyRequest): number | undefined {
  const header = request.headers['content-length'];
  const length = Number(header);
  return header !== undefined && Number.isSafeInteger(length)
    ? length
    : undefined;
}

/** The person behind a request, as the media service sees them. */
export function actorOf(request: FastifyRequest): MediaActor {
  const viewer = viewerOf(request);
  return {
    principal: viewer.principal,
    isMaster: isMaster(viewer.person),
    canSee: (topic) => canSee(request, topic),
  };
}

const itemResponse = { 200: mediaItemSchema };

/** Route options, declared once: access (ADR 0008) and contract schemas (ND-08). */
const OPTIONS = {
  list: {
    config: { access: { topicParam: 'topic' } },
    schema: { params: topicParams, response: { 200: mediaListSchema } },
  },
  create: {
    config: { access: { ...UPLOAD, topicParam: 'topic' } },
    schema: {
      params: topicParams,
      body: createMediaRequestSchema,
      response: { 201: mediaItemSchema },
    },
  },
  upload: {
    config: { access: UPLOAD },
    schema: { params: mediaParams, response: itemResponse },
  },
  item: {
    config: { access: SIGNED_IN },
    schema: { params: mediaParams, response: itemResponse },
  },
  stream: { config: { access: SIGNED_IN }, schema: { params: mediaParams } },
  retry: {
    config: { access: MASTER },
    schema: { params: mediaParams, response: itemResponse },
  },
  remove: {
    config: { access: MASTER },
    schema: { params: mediaParams, response: { 204: z.undefined() } },
  },
} as const;

/** The media library's routes for people (KBC-034, ADR 0022). */
export const mediaRoutes =
  (service: MediaService): FastifyPluginAsync =>
  async (app) => {
    // The upload body is streamed to disk as it arrives, never buffered (FR-2).
    app.addContentTypeParser(
      'application/octet-stream',
      (_request, payload, done) => done(null, payload),
    );
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get('/api/v1/topics/:topic/media', OPTIONS.list, async (request) => ({
      items: service.list(actorOf(request), request.params.topic),
    }));
    typed.post(
      '/api/v1/topics/:topic/media',
      OPTIONS.create,
      async (request, reply) => {
        const created = service.create(
          actorOf(request),
          request.params.topic,
          request.body,
        );
        return reply.code(201).send(created);
      },
    );
    registerItemRoutes(typed, service);
  };

type TypedApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

function registerItemRoutes(typed: TypedApp, service: MediaService): void {
  typed.put('/api/v1/media/:id/file', OPTIONS.upload, async (request) =>
    service.receiveFile(actorOf(request), request.params.id, {
      body: uploadBodyOf(request.body),
      declaredBytes: declaredLengthOf(request),
    }),
  );
  typed.get('/api/v1/media/:id', OPTIONS.item, async (request) =>
    service.get(actorOf(request), request.params.id),
  );
  typed.get(
    '/api/v1/media/:id/stream',
    OPTIONS.stream,
    async (request, reply) => {
      const file = await service.playable(actorOf(request), request.params.id);
      return serveMedia({
        id: request.params.id,
        file,
        request,
        reply,
        open: service,
      });
    },
  );
  registerMasterRoutes(typed, service);
}

/** Masters only: "Tentar de novo" and "Remover" (FR-7, FR-8). */
function registerMasterRoutes(typed: TypedApp, service: MediaService): void {
  typed.post('/api/v1/media/:id/retry', OPTIONS.retry, async (request) =>
    service.retry(actorOf(request), request.params.id),
  );
  typed.delete('/api/v1/media/:id', OPTIONS.remove, async (request, reply) => {
    await service.remove(actorOf(request), request.params.id);
    return reply.code(204).send();
  });
}
