import {
  changeDocumentBatchRequestSchema,
  chooseRecordingsRequestSchema,
  chooseRecordingsResponseSchema,
  clearReadyUploadsRequestSchema,
  clearReadyUploadsResponseSchema,
  contentCostsSchema,
  createDocumentUploadRequestSchema,
  createDocumentUploadResponseSchema,
  documentBatchSchema,
  documentUploadListSchema,
  documentUploadSchema,
  topicSlugSchema,
} from '@kb-chat/contracts';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { RouteAccess } from '../auth/index.js';
import type {
  DocumentUploadService,
  UploadActor,
} from './document-upload-service.js';

/** The tus 1.0 core, as the media library speaks it (ADR 0033). */
const TUS_VERSION = '1.0.0';
const PART_TYPE = 'application/offset+octet-stream';
/** BR-1: who may send audio may send documents (the same permission). */
const UPLOAD: RouteAccess = { feature: 'media-upload' };

const uploadParams = z.object({ id: z.uuid() });
const offsetSchema = z
  .string()
  .regex(/^\d{1,13}$/)
  .transform(Number);

const tusReply = (reply: FastifyReply, offset: number) =>
  reply
    .code(204)
    .header('tus-resumable', TUS_VERSION)
    .header('upload-offset', offset)
    .header('cache-control', 'no-store');

export interface DocumentUploadRouteDeps {
  readonly service: DocumentUploadService;
  readonly actorOf: (request: FastifyRequest) => UploadActor;
  /** Uploads per person per minute (the media library's own limit). */
  readonly createPerMinute?: number;
}

/** Sending documents and links from the app (KBC-149 FR-1), and what is on its way. */
export const documentUploadRoutes =
  (deps: DocumentUploadRouteDeps): FastifyPluginAsync =>
  async (app) => {
    app.addContentTypeParser(PART_TYPE, (_request, payload, done) =>
      done(null, payload),
    );
    registerCreate(app, deps);
    registerList(app, deps);
    registerChanges(app, deps);
    registerSends(app, deps);
    registerParts(app, deps);
  };

function registerCreate(app: FastifyInstance, deps: DocumentUploadRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/topics/:topic/documents',
    {
      config: {
        access: { ...UPLOAD, topicParam: 'topic' },
        ...(deps.createPerMinute && {
          rateLimit: { max: deps.createPerMinute, timeWindow: '1 minute' },
        }),
      },
      schema: {
        params: z.object({ topic: topicSlugSchema }),
        body: createDocumentUploadRequestSchema,
        response: {
          200: createDocumentUploadResponseSchema,
          201: createDocumentUploadResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const answer = await deps.service.create(
        deps.actorOf(request),
        request.params.topic,
        request.body,
      );
      return reply.code(answer.outcome === 'created' ? 201 : 200).send(answer);
    },
  );
}

function registerList(app: FastifyInstance, deps: DocumentUploadRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/v1/document-uploads',
    {
      config: { access: UPLOAD },
      schema: { response: { 200: documentUploadListSchema } },
    },
    async (request) => deps.service.list(deps.actorOf(request)),
  );
  app
    .withTypeProvider<ZodTypeProvider>()
    .post(
      '/api/v1/document-uploads/clear-ready',
      CLEAR_OPTIONS,
      async (request) => ({
        cleared: await deps.service.clearReady(
          deps.actorOf(request),
          request.body.topic,
        ),
      }),
    );
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/v1/document-uploads/costs',
    {
      config: { access: UPLOAD },
      schema: { response: { 200: contentCostsSchema } },
    },
    async () => deps.service.costs(),
  );
}

const BATCH_OPTIONS = {
  config: { access: UPLOAD },
  schema: {
    params: uploadParams,
    body: changeDocumentBatchRequestSchema,
    response: { 200: documentBatchSchema },
  },
};

const CLEAR_OPTIONS = {
  config: { access: UPLOAD },
  schema: {
    body: clearReadyUploadsRequestSchema,
    response: { 200: clearReadyUploadsResponseSchema },
  },
};

const REMOVE_OPTIONS = {
  config: { access: UPLOAD },
  schema: { params: uploadParams, response: { 204: z.undefined() } },
};

const CHOOSE_OPTIONS = {
  config: { access: UPLOAD },
  schema: {
    params: uploadParams,
    body: chooseRecordingsRequestSchema,
    response: { 200: chooseRecordingsResponseSchema },
  },
};

const RETRY_OPTIONS = {
  config: { access: UPLOAD },
  schema: { params: uploadParams, response: { 200: documentUploadSchema } },
};

/** An inclusion's ceiling, an item sent again and an item taken out (KBC-009 R3). */
function registerChanges(app: FastifyInstance, deps: DocumentUploadRouteDeps) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.patch('/api/v1/document-batches/:id', BATCH_OPTIONS, async (request) =>
    deps.service.changeBatch(
      deps.actorOf(request),
      request.params.id,
      request.body.capUsd,
    ),
  );
  typed.delete(
    '/api/v1/document-uploads/:id',
    REMOVE_OPTIONS,
    async (request, reply) => {
      await deps.service.remove(deps.actorOf(request), request.params.id);
      return reply.code(204).send();
    },
  );
}

/** A list's chosen recordings, and a failed item sent again (KBC-186). */
function registerSends(app: FastifyInstance, deps: DocumentUploadRouteDeps) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/document-uploads/:id/choose',
    CHOOSE_OPTIONS,
    async (request) =>
      deps.service.choose(
        deps.actorOf(request),
        request.params.id,
        request.body,
      ),
  );
  typed.post(
    '/api/v1/document-uploads/:id/retry',
    RETRY_OPTIONS,
    async (request) =>
      deps.service.retry(deps.actorOf(request), request.params.id),
  );
}

const PART_OPTIONS = {
  config: { access: UPLOAD },
  schema: { params: uploadParams, response: { 204: z.undefined() } },
};

/** tus HEAD and PATCH on the upload (ADR 0033): the creation is the POST above. */
function registerParts(app: FastifyInstance, deps: DocumentUploadRouteDeps) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.head(
    '/api/v1/document-uploads/:id/upload',
    PART_OPTIONS,
    async (request, reply) => {
      const status = await deps.service.uploadStatus(
        deps.actorOf(request),
        request.params.id,
      );
      return tusReply(reply, status.offset)
        .header('upload-length', status.length)
        .send();
    },
  );
  typed.patch(
    '/api/v1/document-uploads/:id/upload',
    PART_OPTIONS,
    async (request, reply) => {
      const next = await deps.service.receivePart(
        deps.actorOf(request),
        request.params.id,
        partOf(request),
      );
      return tusReply(reply, next).send();
    },
  );
}

/** A PATCH's body and its Upload-Offset, as tus sends them. */
function partOf(request: FastifyRequest): { body: Readable; offset: number } {
  const offset = offsetSchema.safeParse(request.headers['upload-offset']);
  if (!offset.success)
    throw new AppError('VALIDATION_FAILED', 'Upload-Offset is required', {
      details: { field: 'offset' },
    });
  if (!(request.body instanceof Readable))
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', `Send a part as ${PART_TYPE}`);
  return { body: request.body, offset: offset.data };
}
