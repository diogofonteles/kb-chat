import {
  MAX_RAW_TRANSCRIPT_BYTES,
  completeTranscodeRequestSchema,
  completeTranscribeRequestSchema,
  failJobRequestSchema,
  heartbeatRequestSchema,
  leaseRequestSchema,
  leasedJobSchema,
  mediaJobIdSchema,
  transcriptionTermsSchema,
} from '@kb-chat/contracts';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import { PUBLIC } from '../auth/index.js';
import { serveMedia } from './serve-media.js';
import type {
  TranscriberService,
  WorkerIdentity,
} from './transcriber-service.js';
import type { TranscriptionService } from './transcription-service.js';
import type { WorkerService } from './worker-service.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The worker a token names; set on the worker routes only. */
    workerIdentity: WorkerIdentity | null;
  }
}

const jobParams = z.object({ id: mediaJobIdSchema });
const audioQuery = z.object({ leaseId: z.uuid() });

export interface WorkerRoutesDeps {
  readonly service: WorkerService;
  readonly transcribers: TranscriberService;
  readonly transcription: TranscriptionService;
}

/** The bearer token of a request, or ''. */
const bearerOf = (request: FastifyRequest): string => {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
};

function identityOf(request: FastifyRequest): WorkerIdentity {
  if (!request.workerIdentity)
    throw new AppError('UNAUTHENTICATED', 'A valid worker token is required');
  return request.workerIdentity;
}

/**
 * Whose lease a call names: a paired transcriber's leases carry its token's name, whatever
 * the body says; the VM worker names itself (ADR 0022 §3).
 */
const ownerOf = (
  request: FastifyRequest,
  body: { worker: string; leaseId: string },
) => ({
  worker: identityOf(request).leaseName ?? body.worker,
  leaseId: body.leaseId,
});

/** The kinds asked that this token may lease; none of them is 403. */
function allowedKinds(
  identity: WorkerIdentity,
  asked: readonly WorkerIdentity['kinds'][number][],
) {
  const kinds = asked.filter((kind) => identity.kinds.includes(kind));
  if (kinds.length === 0)
    throw new AppError('FORBIDDEN', 'This worker may not lease these jobs');
  return kinds;
}

const route = <T extends z.ZodType>(body: T) => ({
  config: { access: PUBLIC },
  schema: { params: jobParams, body, response: { 204: z.undefined() } },
});

const OPTIONS = {
  lease: {
    config: { access: PUBLIC },
    schema: {
      body: leaseRequestSchema,
      response: { 200: leasedJobSchema, 204: z.undefined() },
    },
  },
  terms: {
    config: { access: PUBLIC },
    schema: { response: { 200: transcriptionTermsSchema } },
  },
  audio: {
    config: { access: PUBLIC },
    schema: { params: jobParams, querystring: audioQuery },
  },
  transcript: {
    ...route(completeTranscribeRequestSchema),
    // An hour of speech is a few MB of raw JSON; the default limit is 1 MB.
    bodyLimit: MAX_RAW_TRANSCRIPT_BYTES,
  },
} as const;

/** Every worker call names its token: unknown or revoked is 401 (FR-6). */
const identifyWorker =
  (transcribers: TranscriberService) => async (request: FastifyRequest) => {
    request.workerIdentity = transcribers.identify(bearerOf(request));
    if (!request.workerIdentity)
      throw new AppError('UNAUTHENTICATED', 'A valid worker token is required');
  };

/**
 * The worker protocol (ADR 0022 §3, ADR 0023): no session, a worker token instead (the
 * VM's or a paired transcriber's, BR-2). The routes are public for the session guard; this
 * scope identifies the token on every call.
 */
export const workerRoutes =
  (deps: WorkerRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    app.decorateRequest('workerIdentity', null);
    app.addHook('onRequest', identifyWorker(deps.transcribers));
    registerLease(app, deps.service);
    registerBeatAndFail(app, deps.service);
    registerTranscode(app, deps.service);
    registerTranscriberReads(app, deps.transcription);
    registerTranscript(app, deps.transcription);
  };

function registerLease(app: FastifyInstance, service: WorkerService): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/media-worker/jobs/lease',
    OPTIONS.lease,
    async (request, reply) => {
      const identity = identityOf(request);
      const job = service.lease({
        worker: identity.leaseName ?? request.body.worker,
        kinds: allowedKinds(identity, request.body.kinds),
      });
      return job ? reply.code(200).send(job) : reply.code(204).send();
    },
  );
}

function registerBeatAndFail(
  app: FastifyInstance,
  service: WorkerService,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/media-worker/jobs/:id/heartbeat',
    route(heartbeatRequestSchema),
    async (request, reply) => {
      const { body } = request;
      service.heartbeat(request.params.id, {
        ...ownerOf(request, body),
        progress: body.progress,
      });
      return reply.code(204).send();
    },
  );
  typed.post(
    '/api/v1/media-worker/jobs/:id/fail',
    route(failJobRequestSchema),
    async (request, reply) => {
      await service.fail(request.params.id, {
        ...request.body,
        ...ownerOf(request, request.body),
      });
      return reply.code(204).send();
    },
  );
}

function registerTranscode(app: FastifyInstance, service: WorkerService): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/media-worker/jobs/:id/complete',
    route(completeTranscodeRequestSchema),
    async (request, reply) => {
      await service.completeTranscode(request.params.id, {
        ...request.body,
        ...ownerOf(request, request.body),
      });
      return reply.code(204).send();
    },
  );
}

/** The transcriber's reads (ADR 0023 §1): the term list and the leased job's audio. */
function registerTranscriberReads(
  app: FastifyInstance,
  transcription: TranscriptionService,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get('/api/v1/media-worker/terms', OPTIONS.terms, async () =>
    transcription.terms(),
  );
  typed.get(
    '/api/v1/media-worker/jobs/:id/audio',
    OPTIONS.audio,
    async (request, reply) => {
      const { id } = request.params;
      const owner = {
        jobId: id,
        ...ownerOf(request, { worker: '', leaseId: request.query.leaseId }),
      };
      const file = await transcription.audio(owner);
      return serveMedia({ id, file, request, reply, open: transcription });
    },
  );
}

/** The raw result of a transcription (ADR 0023 §4). */
function registerTranscript(
  app: FastifyInstance,
  transcription: TranscriptionService,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/media-worker/jobs/:id/transcript',
    OPTIONS.transcript,
    async (request, reply) => {
      const owner = {
        jobId: request.params.id,
        ...ownerOf(request, request.body),
      };
      await transcription.complete(owner, request.body);
      return reply.code(204).send();
    },
  );
}
