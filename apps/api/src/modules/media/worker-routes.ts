import {
  MAX_DIARIZATION_BYTES,
  MAX_RAW_TRANSCRIPT_BYTES,
  completeSilencesRequestSchema,
  completeDiarizeRequestSchema,
  completeTranscodeRequestSchema,
  completeTranscribeRequestSchema,
  completeWaveformRequestSchema,
  completeVoicePrintRequestSchema,
  failJobRequestSchema,
  heartbeatRequestSchema,
  leaseRequestSchema,
  leasedJobSchema,
  type MediaJobKind,
  mediaJobIdSchema,
  mediaIdSchema,
  transcriptionTermsSchema,
  workerVoiceProfilesSchema,
} from '@kb-chat/contracts';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import { TRANSCRIBER_LEASE_PREFIX } from '../../ports/transcriber-store.js';
import { PUBLIC } from '../auth/index.js';
import { serveMedia } from './serve-media.js';
import type { DiarizationService } from './diarization-service.js';
import type {
  TranscriberService,
  WorkerIdentity,
} from './transcriber-service.js';
import type { SilenceService } from './silence-service.js';
import type { TranscriptionService } from './transcription-service.js';
import type { WaveformService } from './waveform-service.js';
import type { VoicePrintService } from './voice-print-service.js';
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
  /** Silence maps (KBC-044). */
  readonly silences: SilenceService;
  /** Waveforms (KBC-066). */
  readonly waveforms: WaveformService;
  readonly diarization: DiarizationService;
  /** Voice prints (KBC-071). */
  readonly voicePrints: VoicePrintService;
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
function ownerOf(
  request: FastifyRequest,
  body: { worker: string; leaseId: string },
) {
  return {
    worker: workerNameOf(request, body.worker, notThisWorkers),
    leaseId: body.leaseId,
  };
}

/**
 * The name a call's leases carry: a paired transcriber's is its token's; the VM names
 * itself, but never as a paired transcriber (BR-2), or `refuse` is thrown.
 */
function workerNameOf(
  request: FastifyRequest,
  named: string,
  refuse: () => AppError,
): string {
  const { leaseName } = identityOf(request);
  if (leaseName) return leaseName;
  if (named.startsWith(TRANSCRIBER_LEASE_PREFIX)) throw refuse();
  return named;
}

const notTheVmsName = () =>
  new AppError('FORBIDDEN', 'This worker may not take that name');

const notThisWorkers = () =>
  new AppError('NOT_FOUND', 'No such job for this worker');

/**
 * A job whose kind the token may not lease is not there for it (404, BR-2): the VM never
 * touches a transcription, a transcriber never a conversion.
 */
function assertJobKind(
  request: FastifyRequest,
  input: { jobId: string; service: WorkerService; only?: MediaJobKind },
): void {
  const kind = input.service.kindOf(input.jobId);
  if (!kind) return;
  const allowed = identityOf(request).kinds.includes(kind);
  if (!allowed || (input.only && kind !== input.only)) throw notThisWorkers();
}

/** The routes below are the transcriber's only (ADR 0023): other tokens get 404. */
function assertTranscriber(request: FastifyRequest): void {
  const { kinds } = identityOf(request);
  if (!kinds.includes('transcribe') && !kinds.includes('diarize'))
    throw notThisWorkers();
}

/** A separation's result comes only from a token that may separate voices (FR-6). */
function assertDiarizer(request: FastifyRequest): void {
  if (!identityOf(request).kinds.includes('diarize')) throw notThisWorkers();
}

/** A print goes only to, and comes only from, a token marked for it (ADR 0032). */
function assertVoicePrinter(request: FastifyRequest): void {
  if (!identityOf(request).kinds.includes('voice-profile'))
    throw notThisWorkers();
}

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
  sourceAudio: {
    config: { access: PUBLIC },
    schema: {
      params: jobParams.extend({ mediaId: mediaIdSchema }),
      querystring: audioQuery,
    },
  },
  voiceProfiles: {
    config: { access: PUBLIC },
    schema: {
      params: jobParams,
      querystring: audioQuery,
      response: { 200: workerVoiceProfilesSchema },
    },
  },
  transcript: {
    ...route(completeTranscribeRequestSchema),
    // An hour of speech is a few MB of raw JSON; the default limit is 1 MB.
    bodyLimit: MAX_RAW_TRANSCRIPT_BYTES,
  },
  diarization: {
    ...route(completeDiarizeRequestSchema),
    bodyLimit: MAX_DIARIZATION_BYTES,
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
    registerBeat(app, deps.service);
    registerFail(app, deps.service);
    registerTranscode(app, deps.service);
    registerSilences(app, deps);
    registerWaveform(app, deps);
    registerTranscriberReads(app, deps.transcription);
    registerTranscript(app, deps.transcription);
    registerDiarization(app, deps.diarization);
    registerVoicePrints(app, deps);
  };

function registerLease(app: FastifyInstance, service: WorkerService): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/media-worker/jobs/lease',
    OPTIONS.lease,
    async (request, reply) => {
      const identity = identityOf(request);
      const job = service.lease({
        worker: workerNameOf(request, request.body.worker, notTheVmsName),
        kinds: allowedKinds(identity, request.body.kinds),
        // ADR 0023: a paired transcriber holds one job at a time.
        oneAtATime: identity.leaseName !== null,
      });
      return job ? reply.code(200).send(job) : reply.code(204).send();
    },
  );
}

function registerBeat(app: FastifyInstance, service: WorkerService): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/media-worker/jobs/:id/heartbeat',
    route(heartbeatRequestSchema),
    async (request, reply) => {
      const { body } = request;
      assertJobKind(request, { jobId: request.params.id, service });
      service.heartbeat(request.params.id, {
        ...ownerOf(request, body),
        progress: body.progress,
      });
      return reply.code(204).send();
    },
  );
}

function registerFail(app: FastifyInstance, service: WorkerService): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/media-worker/jobs/:id/fail',
    route(failJobRequestSchema),
    async (request, reply) => {
      assertJobKind(request, { jobId: request.params.id, service });
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
      assertJobKind(request, {
        jobId: request.params.id,
        service,
        only: 'transcode',
      });
      await service.completeTranscode(request.params.id, {
        ...request.body,
        ...ownerOf(request, request.body),
      });
      return reply.code(204).send();
    },
  );
}

/** A silence map measured by the VM worker (KBC-044 FR-1). */
function registerSilences(app: FastifyInstance, deps: WorkerRoutesDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/media-worker/jobs/:id/silences',
    route(completeSilencesRequestSchema),
    async (request, reply) => {
      const jobId = request.params.id;
      assertJobKind(request, {
        jobId,
        service: deps.service,
        only: 'silences',
      });
      deps.silences.complete(
        { jobId, ...ownerOf(request, request.body) },
        request.body,
      );
      return reply.code(204).send();
    },
  );
}

/** The peaks measured by the VM worker (KBC-066). */
function registerWaveform(app: FastifyInstance, deps: WorkerRoutesDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/media-worker/jobs/:id/waveform',
    route(completeWaveformRequestSchema),
    async (request, reply) => {
      const jobId = request.params.id;
      assertJobKind(request, {
        jobId,
        service: deps.service,
        only: 'waveform',
      });
      deps.waveforms.complete(
        { jobId, ...ownerOf(request, request.body) },
        request.body,
      );
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
  typed.get('/api/v1/media-worker/terms', OPTIONS.terms, async (request) => {
    assertTranscriber(request);
    return transcription.terms();
  });
  typed.get(
    '/api/v1/media-worker/jobs/:id/audio',
    OPTIONS.audio,
    async (request, reply) => {
      const { id } = request.params;
      assertTranscriber(request);
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
      assertTranscriber(request);
      const owner = {
        jobId: request.params.id,
        ...ownerOf(request, request.body),
      };
      await transcription.complete(owner, request.body);
      return reply.code(204).send();
    },
  );
}

/** The turns of a voice separation (KBC-064 FR-2): no voice print has a field here (BR-1). */
function registerDiarization(
  app: FastifyInstance,
  diarization: DiarizationService,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/media-worker/jobs/:id/diarization',
    OPTIONS.diarization,
    async (request, reply) => {
      assertDiarizer(request);
      const owner = {
        jobId: request.params.id,
        ...ownerOf(request, request.body),
      };
      await diarization.complete(owner, request.body);
      return reply.code(204).send();
    },
  );
}

/** The print of a `voice-profile` job, and the audio of the recordings it uses (FR-2). */
function registerVoicePrints(
  app: FastifyInstance,
  deps: WorkerRoutesDeps,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { voicePrints, transcription } = deps;
  typed.get(
    '/api/v1/media-worker/jobs/:id/audio/:mediaId',
    OPTIONS.sourceAudio,
    async (request, reply) => {
      const { id, mediaId } = request.params;
      assertVoicePrinter(request);
      const owner = {
        jobId: id,
        ...ownerOf(request, { worker: '', leaseId: request.query.leaseId }),
      };
      const usesMedia = voicePrints.usesMedia(owner, mediaId);
      const file = await transcription.sourceAudio({ mediaId, usesMedia });
      return serveMedia({ id, file, request, reply, open: transcription });
    },
  );
  typed.post(
    '/api/v1/media-worker/jobs/:id/voice-print',
    route(completeVoicePrintRequestSchema),
    async (request, reply) => {
      assertVoicePrinter(request);
      const owner = {
        jobId: request.params.id,
        ...ownerOf(request, request.body),
      };
      await voicePrints.complete(owner, request.body);
      return reply.code(204).send();
    },
  );
  typed.get(
    '/api/v1/media-worker/jobs/:id/voice-profiles',
    OPTIONS.voiceProfiles,
    async (request) => {
      assertVoicePrinter(request);
      return voicePrints.printsFor({
        jobId: request.params.id,
        ...ownerOf(request, { worker: '', leaseId: request.query.leaseId }),
      });
    },
  );
}
