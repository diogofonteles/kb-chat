import {
  createMediaRequestSchema,
  mediaIdSchema,
  mediaItemSchema,
  mediaListSchema,
  topicSlugSchema,
  updateMediaRequestSchema,
  type MediaItem,
  uploadCheckRequestSchema,
  uploadCheckSchema,
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
import {
  canSee,
  hasFeature,
  isMaster,
  mediaQuotaOf,
  viewerOf,
  type RouteAccess,
} from '../auth/index.js';
import { registerUploadRoutes } from './upload-routes.js';
import type { MediaEditService } from './media-edit-service.js';
import type {
  MediaActor,
  MediaService,
  PlanActor,
  UploadPlans,
} from './media-service.js';
import { serveMedia } from './serve-media.js';

/** Listening needs the `media` feature (owner's rule: every feature is granted per person). */
const LISTEN: RouteAccess = { feature: 'media' };
const UPLOAD: RouteAccess = { feature: 'media-upload' };
const MASTER: RouteAccess = { master: true };
const topicParams = z.object({ topic: topicSlugSchema });
const mediaParams = z.object({ id: mediaIdSchema });
/** "Remover" with the recording's tracks listed and confirmed (KBC-073 FR-8). */
const removeQuery = z.object({ cascade: z.literal('true').optional() });

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
    canUpload: hasFeature(viewer.person, 'media-upload'),
    quotaBytes: mediaQuotaOf(viewer),
    seesTracks: hasFeature(viewer.person, 'media-tracks'),
    canSee: (topic) => canSee(request, topic),
  };
}

/** The person, with what decides the guided flow's options (KBC-072 BR-3). */
export function planActorOf(request: FastifyRequest): PlanActor {
  const { person } = viewerOf(request);
  return {
    ...actorOf(request),
    canEdit: hasFeature(person, 'media-edit'),
    canPropose: hasFeature(person, 'media-edit-ai'),
  };
}

const itemResponse = { 200: mediaItemSchema };

/** Route options, declared once: access (ADR 0008) and contract schemas (ND-08). */
const OPTIONS = {
  list: {
    config: { access: { ...LISTEN, topicParam: 'topic' } },
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
  check: {
    config: { access: { ...UPLOAD, topicParam: 'topic' } },
    schema: {
      params: topicParams,
      body: uploadCheckRequestSchema,
      response: { 200: uploadCheckSchema },
    },
  },
  upload: {
    config: { access: UPLOAD },
    schema: { params: mediaParams, response: itemResponse },
  },
  item: {
    config: { access: LISTEN },
    schema: { params: mediaParams, response: itemResponse },
  },
  // Who may edit is decided by the service: 404 without access to it, 403 without the right.
  edit: {
    config: { access: LISTEN },
    schema: {
      params: mediaParams,
      body: updateMediaRequestSchema,
      response: itemResponse,
    },
  },
  stream: { config: { access: LISTEN }, schema: { params: mediaParams } },
  retry: {
    config: { access: MASTER },
    schema: { params: mediaParams, response: itemResponse },
  },
  // Masters, or the uploader cancelling their own upload: decided by the service.
  remove: {
    config: { access: {} },
    schema: {
      params: mediaParams,
      querystring: removeQuery,
      response: { 204: z.undefined() },
    },
  },
} as const;

/** Creating items is bounded per client, on top of the quota. */
const createOptions = (perMinute: number) => ({
  ...OPTIONS.create,
  config: {
    ...OPTIONS.create.config,
    rateLimit: { max: perMinute, timeWindow: '1 minute' },
  },
});

/** The media library's routes for people (KBC-034, ADR 0022). */
export const mediaRoutes =
  (
    service: MediaService,
    editor: MediaEditService,
    options: {
      /** Items created per minute per client (MEDIA_CREATE_RATE_LIMIT). */
      readonly createPerMinute: number;
      /** The guided flow's plans (KBC-072). */
      readonly plans: UploadPlans;
    },
  ): FastifyPluginAsync =>
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
    registerCreate(typed, { service, ...options });
    typed.post(
      '/api/v1/topics/:topic/media/check',
      OPTIONS.check,
      async (request) =>
        service.check(actorOf(request), request.params.topic, request.body),
    );
    registerUploadRoutes(app, service, actorOf);
    registerItemRoutes(typed, service);
    registerEditRoute(typed, service, editor);
  };

/** An item with its plan: a refused option creates nothing (KBC-072 AC-13). */
function createPlanned(
  { actor, topic }: { actor: PlanActor; topic: string },
  body: z.output<typeof createMediaRequestSchema>,
  { service, plans }: { service: MediaService; plans: UploadPlans },
): MediaItem {
  const { plan, ...item } = body;
  if (plan) plans.assertAllowed(actor, plan);
  const created = service.create(actor, topic, item);
  if (plan) plans.record(actor, created.id, plan);
  return created;
}

type TypedApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

function registerCreate(
  typed: TypedApp,
  deps: {
    readonly service: MediaService;
    readonly plans: UploadPlans;
    readonly createPerMinute: number;
  },
): void {
  typed.post(
    '/api/v1/topics/:topic/media',
    createOptions(deps.createPerMinute),
    async (request, reply) => {
      const created = createPlanned(
        { actor: planActorOf(request), topic: request.params.topic },
        request.body,
        deps,
      );
      return reply.code(201).send(created);
    },
  );
}

/** "Editar informações" (KBC-050 FR-1): the answer is the item as the person now sees it. */
function registerEditRoute(
  typed: TypedApp,
  service: MediaService,
  editor: MediaEditService,
): void {
  typed.patch('/api/v1/media/:id', OPTIONS.edit, async (request) => {
    const actor = actorOf(request);
    editor.edit(actor, request.params.id, request.body);
    return service.get(actor, request.params.id);
  });
}

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
    await service.remove(actorOf(request), request.params.id, {
      cascade: request.query.cascade === 'true',
    });
    return reply.code(204).send();
  });
}
