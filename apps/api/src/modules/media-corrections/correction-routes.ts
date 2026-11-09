import {
  correctionGroupUndoResultSchema,
  correctionHistoryQuerySchema,
  correctionHistorySchema,
  mediaIdSchema,
  occurrencesQuerySchema,
  occurrencesSchema,
  transcriptCorrectionBatchRequestSchema,
  transcriptCorrectionBatchResultSchema,
  transcriptCorrectionRequestSchema,
  transcriptCorrectionResultSchema,
} from '@kb-chat/contracts';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyPluginAsync,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteAccess } from '../auth/index.js';
import { actorOf } from '../media/index.js';
import type { TranscriptCorrectionService } from './transcript-correction-service.js';

/** Correcting, and reading the log, is `media-correct` on top of listening (ADR 0034 §7). */
const CORRECT: RouteAccess = { feature: ['media', 'media-correct'] };
const params = z.object({ id: mediaIdSchema });
const rowParams = params.extend({ correctionId: z.uuid() });
const groupParams = params.extend({ groupId: z.uuid() });
const BASE = '/api/v1/media/:id/transcript';

const OPTIONS = {
  correct: {
    config: { access: CORRECT },
    schema: {
      params,
      body: transcriptCorrectionRequestSchema,
      response: {
        200: transcriptCorrectionResultSchema,
        201: transcriptCorrectionResultSchema,
      },
    },
  },
  history: {
    config: { access: CORRECT },
    schema: {
      params,
      querystring: correctionHistoryQuerySchema,
      response: { 200: correctionHistorySchema },
    },
  },
  undo: {
    config: { access: CORRECT },
    schema: {
      params: rowParams,
      response: {
        200: transcriptCorrectionResultSchema,
        201: transcriptCorrectionResultSchema,
      },
    },
  },
  batch: {
    config: { access: CORRECT },
    schema: {
      params,
      body: transcriptCorrectionBatchRequestSchema,
      response: {
        200: transcriptCorrectionBatchResultSchema,
        201: transcriptCorrectionBatchResultSchema,
      },
    },
  },
  undoGroup: {
    config: { access: CORRECT },
    schema: {
      params: groupParams,
      response: { 200: correctionGroupUndoResultSchema },
    },
  },
  occurrences: {
    config: { access: CORRECT },
    schema: {
      params,
      querystring: occurrencesQuerySchema,
      response: { 200: occurrencesSchema },
    },
  },
} as const;

type Typed = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

/** One word or a few (FR-5), the log (FR-6) and an undo (BR-7). */
function registerSingle(typed: Typed, service: TranscriptCorrectionService) {
  typed.post(`${BASE}/corrections`, OPTIONS.correct, async (request, reply) => {
    const written = service.correct(
      actorOf(request),
      request.params.id,
      request.body,
    );
    return reply.code(written.status).send(written.body);
  });
  typed.get(`${BASE}/corrections`, OPTIONS.history, async (request) =>
    service.history(actorOf(request), request.params.id, request.query.cursor),
  );
  typed.post(
    `${BASE}/corrections/:correctionId/undo`,
    OPTIONS.undo,
    async (request, reply) => {
      const { id, correctionId } = request.params;
      const written = service.undo(actorOf(request), id, correctionId);
      return reply.code(written.status).send(written.body);
    },
  );
}

/** "Corrigir todas": the preview, the group and its undo (FR-12). */
function registerAll(typed: Typed, service: TranscriptCorrectionService) {
  typed.get(`${BASE}/occurrences`, OPTIONS.occurrences, async (request) =>
    service.occurrences(actorOf(request), request.params.id, request.query),
  );
  typed.post(
    `${BASE}/corrections/batch`,
    OPTIONS.batch,
    async (request, reply) => {
      const written = service.batch(
        actorOf(request),
        request.params.id,
        request.body,
      );
      return reply.code(written.status).send(written.body);
    },
  );
  typed.post(
    `${BASE}/corrections/groups/:groupId/undo`,
    OPTIONS.undoGroup,
    async (request) =>
      service.undoGroup(
        actorOf(request),
        request.params.id,
        request.params.groupId,
      ),
  );
}

/** Correcting words of a recording's transcript (KBC-093 FR-5, FR-6, FR-12). */
export const correctionRoutes =
  (service: TranscriptCorrectionService): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    registerSingle(typed, service);
    registerAll(typed, service);
  };
