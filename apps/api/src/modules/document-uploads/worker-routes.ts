import {
  DOC_INGEST_AUDIO_MAX_BYTES,
  docIngestEntriesRequestSchema,
  docIngestResultRequestSchema,
  docIngestStateRequestSchema,
  mediaJobIdSchema,
} from '@kb-chat/contracts';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import { PUBLIC } from '../auth/index.js';
import type { DocIngestWork } from './doc-ingest-queue.js';

const AUDIO_TYPE = 'application/octet-stream';

export interface DocIngestWorkerRoutesDeps {
  readonly queue: DocIngestWork;
  /** The worker the lease names (a paired transcriber's is its token's name). */
  readonly ownerOf: (
    request: FastifyRequest,
    body: { worker: string; leaseId: string },
  ) => { worker: string; leaseId: string };
  /** Only a transcriber marked "Publica no acervo" touches these jobs (404 otherwise). */
  readonly assertDocWorker: (request: FastifyRequest, jobId: string) => void;
}

const jobParams = z.object({ id: mediaJobIdSchema });
const leaseQuery = z.object({ leaseId: z.uuid() });
const audioQuery = leaseQuery.extend({
  name: z.string().min(1).max(255),
});

/** A channel's thousands of titles and addresses. */
const LIST_MAX_BYTES = 16 * 1024 * 1024;

const posted = <T extends z.ZodType>(body: T) => ({
  config: { access: PUBLIC },
  schema: { params: jobParams, body, response: { 204: z.undefined() } },
});

/**
 * The Mac's side of sent documents (KBC-149 FR-2, ADR 0040), inside the worker routes'
 * scope (the token is identified there): the file, each step, the result, and a YouTube
 * link's audio given back as a media item.
 */
export const docIngestWorkerRoutes =
  (deps: DocIngestWorkerRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    app.addContentTypeParser(AUDIO_TYPE, (_request, payload, done) =>
      done(null, payload),
    );
    registerFile(app, deps);
    registerState(app, deps);
    registerResult(app, deps);
    registerEntries(app, deps);
    registerAudio(app, deps);
  };

function registerFile(app: FastifyInstance, deps: DocIngestWorkerRoutesDeps) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/v1/media-worker/jobs/:id/document',
    {
      config: { access: PUBLIC },
      schema: { params: jobParams, querystring: leaseQuery },
    },
    async (request, reply) => {
      const jobId = request.params.id;
      deps.assertDocWorker(request, jobId);
      const owner = deps.ownerOf(request, {
        worker: '',
        leaseId: request.query.leaseId,
      });
      const file = await deps.queue.fileOf({ jobId, ...owner });
      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-length', file.size)
        .header('cache-control', 'no-store')
        .send(createReadStream(file.path));
    },
  );
}

function registerState(app: FastifyInstance, deps: DocIngestWorkerRoutesDeps) {
  app
    .withTypeProvider<ZodTypeProvider>()
    .post(
      '/api/v1/media-worker/jobs/:id/doc-state',
      posted(docIngestStateRequestSchema),
      async (request, reply) => {
        const jobId = request.params.id;
        deps.assertDocWorker(request, jobId);
        await deps.queue.step(
          { jobId, ...deps.ownerOf(request, request.body) },
          request.body,
        );
        return reply.code(204).send();
      },
    );
}

function registerResult(app: FastifyInstance, deps: DocIngestWorkerRoutesDeps) {
  app
    .withTypeProvider<ZodTypeProvider>()
    .post(
      '/api/v1/media-worker/jobs/:id/doc-result',
      posted(docIngestResultRequestSchema),
      async (request, reply) => {
        const jobId = request.params.id;
        deps.assertDocWorker(request, jobId);
        await deps.queue.complete(
          { jobId, ...deps.ownerOf(request, request.body) },
          request.body,
        );
        return reply.code(204).send();
      },
    );
}

/** A list's recordings (KBC-186 R7), for the person to choose from. */
function registerEntries(
  app: FastifyInstance,
  deps: DocIngestWorkerRoutesDeps,
) {
  app
    .withTypeProvider<ZodTypeProvider>()
    .post(
      '/api/v1/media-worker/jobs/:id/doc-entries',
      { ...posted(docIngestEntriesRequestSchema), bodyLimit: LIST_MAX_BYTES },
      async (request, reply) => {
        const jobId = request.params.id;
        deps.assertDocWorker(request, jobId);
        await deps.queue.list(
          { jobId, ...deps.ownerOf(request, request.body) },
          request.body,
        );
        return reply.code(204).send();
      },
    );
}

/** A recording link's audio (KBC-142 BR-5): it becomes the sender's media item. */
function registerAudio(app: FastifyInstance, deps: DocIngestWorkerRoutesDeps) {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/media-worker/jobs/:id/recording-audio',
    {
      config: { access: PUBLIC },
      bodyLimit: DOC_INGEST_AUDIO_MAX_BYTES,
      schema: {
        params: jobParams,
        querystring: audioQuery,
        // Null: refused for good (the sender's quota, level or rights), and the upload says why.
        response: { 200: z.object({ mediaId: z.uuid().nullable() }) },
      },
    },
    async (request) => {
      const jobId = request.params.id;
      deps.assertDocWorker(request, jobId);
      const { leaseId, name } = request.query;
      const owner = deps.ownerOf(request, { worker: '', leaseId });
      const mediaId = await deps.queue.adopt(
        { jobId, ...owner },
        { ...audioOf(request), name },
      );
      return { mediaId };
    },
  );
}

/** The audio's stream and its length (a body without one is refused). */
function audioOf(request: FastifyRequest): { body: Readable; bytes: number } {
  const bytes = Number(request.headers['content-length']);
  const { body } = request;
  if (!(body instanceof Readable) || !Number.isInteger(bytes) || bytes < 1)
    throw new AppError(
      'UNSUPPORTED_MEDIA_TYPE',
      `Send the audio as ${AUDIO_TYPE} with its length`,
    );
  return { body, bytes };
}
