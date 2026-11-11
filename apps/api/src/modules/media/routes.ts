import {
  createMediaRequestSchema,
  mediaIdSchema,
  mediaItemSchema,
  mediaLevelChoicesSchema,
  mediaListSchema,
  topicSlugSchema,
  trackPatchSchema,
  updateMediaBodySchema,
  updateMediaRequestSchema,
  type MediaItem,
  type TrackPatch,
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
import { levelViewsOf } from '../access-levels/index.js';
import {
  assertFeature,
  canSee,
  hasFeature,
  isMaster,
  mediaQuotaOf,
  viewerOf,
  type RouteAccess,
} from '../auth/index.js';
import { registerUploadRoutes } from './upload-routes.js';
import type { EditAuthor, MediaEditService } from './media-edit-service.js';
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

/** The cut the player started on (KBC-073 BR-3). */
const streamQuery = z.object({ v: z.coerce.number().int().min(1).optional() });

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
    seesSubjects: hasFeature(viewer.person, 'media-subjects'),
    searchesSpeech: hasFeature(viewer.person, 'search'),
    displayName: viewer.person.name,
    canSee: (topic) => canSee(request, topic),
    // KBC-105: in a collection with levels, the audios at the person's level and below.
    levelsIn: levelsOf(request),
  };
}

/** The level ids the person sees per collection, once per collection and request. */
export function levelsOf(
  request: FastifyRequest,
): (topic: string) => readonly string[] | null {
  const views = levelViewsOf(request);
  return (topic) => views(topic).allowedLevelIds();
}

/** Who edits, for the levels audit: the master, and the person they act as (ADR 0027). */
function editAuthorOf(request: FastifyRequest): EditAuthor {
  const viewer = viewerOf(request);
  const real = viewer.actor?.viewer ?? viewer;
  return {
    by: real.person.email,
    ...(viewer.actor && { actingAs: viewer.person.email }),
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

const ETAG = /^"(\d+)"$/;

/** The version a write says it read (KBC-066 FR-1): without one it is refused (428). */
export function versionOf(request: FastifyRequest): number {
  const match = ETAG.exec(request.headers['if-match'] ?? '');
  if (!match?.[1])
    throw new AppError('EDIT_VERSION_REQUIRED', 'If-Match is required');
  return Number(match[1]);
}

/** Who writes to a track, from which version. */
export interface TrackCall {
  readonly actor: MediaActor;
  readonly mediaId: string;
  readonly expectedVersion: number;
}

/** The writes on a track that arrive by the item's own routes (KBC-073 FR-1, FR-3). */
export interface TrackWrites {
  patch(call: TrackCall, patch: TrackPatch): void;
  archive(actor: MediaActor, mediaId: string): Promise<void>;
}

const itemResponse = { 200: mediaItemSchema };

/** Route options, declared once: access (ADR 0008) and contract schemas (ND-08). */
const OPTIONS = {
  list: {
    config: { access: { ...LISTEN, topicParam: 'topic' } },
    schema: { params: topicParams, response: { 200: mediaListSchema } },
  },
  levels: {
    config: { access: { ...UPLOAD, topicParam: 'topic' } },
    schema: { params: topicParams, response: { 200: mediaLevelChoicesSchema } },
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
    config: { access: LISTEN },
    schema: { params: mediaParams, response: itemResponse },
  },
  // Who may edit is decided by the service: 404 without access to it, 403 without the right.
  edit: {
    config: { access: LISTEN },
    schema: {
      params: mediaParams,
      body: updateMediaBodySchema,
      response: itemResponse,
    },
  },
  stream: {
    config: { access: LISTEN },
    schema: { params: mediaParams, querystring: streamQuery },
  },
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
      /** A track reached through the same routes as a recording (KBC-073). */
      readonly tracks: TrackWrites;
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
    typed.get(
      '/api/v1/topics/:topic/media/levels',
      OPTIONS.levels,
      async (request) =>
        service.levelChoices(actorOf(request), request.params.topic),
    );
    registerCreate(typed, { service, ...options });
    registerUploadRoutes(app, service, actorOf);
    registerItemRoutes(typed, service, options.tracks);
    registerEditRoute(typed, { service, editor, tracks: options.tracks });
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

function refused(field: string): AppError {
  return new AppError('VALIDATION_FAILED', `${field} is not for this item`, {
    details: { field },
  });
}

/** What an edit of a recording may carry: the track's fields are not for it. */
function recordingEdit(body: z.output<typeof updateMediaBodySchema>) {
  const details = updateMediaRequestSchema.safeParse(body);
  if (!details.success) throw refused('track');
  return details.data;
}

/** What a track's edit may carry: its title is shorter, and it has no author or collection. */
function trackEdit(body: z.output<typeof updateMediaBodySchema>) {
  const patch = trackPatchSchema.safeParse(body);
  if (!patch.success) throw refused('recording');
  return patch.data;
}

/** "Editar informações" (KBC-050 FR-1): the answer is the item as the person now sees it. */
function registerEditRoute(
  typed: TypedApp,
  deps: {
    readonly service: MediaService;
    readonly editor: MediaEditService;
    readonly tracks: TrackWrites;
  },
): void {
  const { service, editor, tracks } = deps;
  typed.patch('/api/v1/media/:id', OPTIONS.edit, async (request) => {
    const actor = actorOf(request);
    const { id } = request.params;
    if (service.isTrack(actor, id)) {
      assertFeature(request, 'media-edit');
      tracks.patch(
        { actor, mediaId: id, expectedVersion: versionOf(request) },
        trackEdit(request.body),
      );
    } else
      await editor.edit(
        { actor, mediaId: id, by: editAuthorOf(request) },
        recordingEdit(request.body),
      );
    return service.get(actor, id);
  });
}

function registerItemRoutes(
  typed: TypedApp,
  service: MediaService,
  tracks: TrackWrites,
): void {
  typed.put('/api/v1/media/:id/file', OPTIONS.upload, async (request) =>
    service.receiveFile(actorOf(request), request.params.id, {
      body: uploadBodyOf(request.body),
      declaredBytes: declaredLengthOf(request),
    }),
  );
  typed.get('/api/v1/media/:id', OPTIONS.item, async (request) =>
    service.get(actorOf(request), request.params.id),
  );
  registerStream(typed, service);
  registerMasterRoutes(typed, service, tracks);
}

function registerStream(typed: TypedApp, service: MediaService): void {
  typed.get(
    '/api/v1/media/:id/stream',
    OPTIONS.stream,
    async (request, reply) => {
      const file = await service.playable(
        actorOf(request),
        request.params.id,
        request.query.v,
      );
      return serveMedia({
        id: request.params.id,
        file,
        request,
        reply,
        open: service,
      });
    },
  );
}

/** Masters only: "Tentar de novo" and "Remover" (FR-7, FR-8). */
function registerMasterRoutes(
  typed: TypedApp,
  service: MediaService,
  tracks: TrackWrites,
): void {
  typed.post('/api/v1/media/:id/retry', OPTIONS.retry, async (request) =>
    service.retry(actorOf(request), request.params.id),
  );
  typed.delete('/api/v1/media/:id', OPTIONS.remove, async (request, reply) => {
    const actor = actorOf(request);
    const { id } = request.params;
    if (service.isTrack(actor, id)) {
      assertFeature(request, 'media');
      assertFeature(request, 'media-edit');
      await tracks.archive(actor, id);
    } else
      await service.remove(actor, id, {
        cascade: request.query.cascade === 'true',
      });
    return reply.code(204).send();
  });
}
