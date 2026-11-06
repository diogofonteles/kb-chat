import {
  GROQ_MODEL,
  GROQ_PARAMETERS_VERSION,
  GROQ_VAD,
  MAX_GROQ_CHUNK_BYTES,
  MAX_RAW_TRANSCRIPT_BYTES,
  TERMS_TOKEN_LIMIT,
  completeGroqTranscriptRequestSchema,
  groqChunkQuerySchema,
  groqChunkResultSchema,
  mediaJobIdSchema,
} from '@kb-chat/contracts';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { LeaseOwner } from '../../ports/media-store.js';
import { PUBLIC } from '../auth/index.js';
import type { GroqService } from './groq-service.js';
import type { TranscriptionService } from './transcription-service.js';

const FLAC = 'audio/flac';
const params = z.object({ id: mediaJobIdSchema });

/** What a Groq transcript is stored with: the request and the VAD the VM used. */
const GROQ_PARAMETERS = {
  model: GROQ_MODEL,
  language: 'pt',
  temperature: 0,
  response_format: 'verbose_json',
  timestamp_granularities: ['word', 'segment'],
  chunk_max_s: 28,
  prompt_max_tokens: TERMS_TOKEN_LIMIT,
  vad: GROQ_VAD,
};

/** Who made a Groq transcript, and how (stored with it, ADR 0023 §4). */
const GROQ_PROVENANCE = {
  provider: 'groq',
  model: GROQ_MODEL,
  parametersVersion: GROQ_PARAMETERS_VERSION,
  parameters: GROQ_PARAMETERS,
} as const;

export interface GroqWorkerRoutesDeps {
  readonly groq: GroqService;
  readonly transcription: TranscriptionService;
  /** The lease a call names, for the VM only (paired transcribers get 404). */
  readonly ownerOf: (
    request: FastifyRequest,
    body: { worker: string; leaseId: string },
  ) => Omit<LeaseOwner, 'jobId'>;
}

const OPTIONS = {
  chunk: {
    config: { access: PUBLIC },
    bodyLimit: MAX_GROQ_CHUNK_BYTES,
    schema: {
      params,
      querystring: groqChunkQuerySchema,
      response: { 200: groqChunkResultSchema, 429: z.undefined() },
    },
  },
  transcript: {
    config: { access: PUBLIC },
    bodyLimit: MAX_RAW_TRANSCRIPT_BYTES,
    schema: {
      params,
      body: completeGroqTranscriptRequestSchema,
      response: { 204: z.undefined() },
    },
  },
} as const;

/**
 * The VM worker's side of the Groq fallback (KBC-037): one chunk of FLAC at a time, which
 * the API sends to Groq with the key it alone holds (ADR 0017), and the chunks put together.
 * Inside the worker routes' scope: the token is already identified.
 */
export const groqWorkerRoutes =
  (deps: GroqWorkerRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    app.addContentTypeParser(
      FLAC,
      { parseAs: 'buffer', bodyLimit: MAX_GROQ_CHUNK_BYTES },
      (_request, body, done) => done(null, body),
    );
    registerChunk(app, deps);
    registerTranscript(app, deps);
  };

/** One chunk to Groq; 429 with `retry-after` when the pace or Groq says to wait (FR-3). */
function registerChunk(app: FastifyInstance, deps: GroqWorkerRoutesDeps) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/media-worker/jobs/:id/groq/chunks',
    OPTIONS.chunk,
    async (request, reply) => {
      const { query, body } = request;
      if (!Buffer.isBuffer(body) || body.length === 0)
        throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Send the chunk as FLAC');
      const owner = {
        jobId: request.params.id,
        ...deps.ownerOf(request, query),
      };
      const outcome = await deps.groq.transcribeChunk(owner, {
        query,
        audio: body,
      });
      if (outcome.kind === 'ok')
        return reply.code(200).send({ result: outcome.result });
      const seconds = Math.ceil(outcome.retryAfterMs / 1000);
      return reply.code(429).header('retry-after', String(seconds)).send();
    },
  );
}

/** The chunks put together: stored and derived as the Mac's are (ADR 0023 §4). */
function registerTranscript(app: FastifyInstance, deps: GroqWorkerRoutesDeps) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/media-worker/jobs/:id/groq/transcript',
    OPTIONS.transcript,
    async (request, reply) => {
      const { body } = request;
      const owner = {
        jobId: request.params.id,
        ...deps.ownerOf(request, body),
      };
      deps.groq.assertHolds(owner);
      await deps.transcription.complete(owner, {
        ...GROQ_PROVENANCE,
        termsVersion: body.termsVersion,
        vad: body.vad,
        speechRatio: body.speechRatio,
        elapsedMs: body.elapsedMs,
        raw: body.raw,
      });
      return reply.code(204).send();
    },
  );
}
