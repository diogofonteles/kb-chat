import {
  localTranscriberStartSchema,
  transcriberStatusOverviewSchema,
  transcriberStatusReportSchema,
} from '@kb-chat/contracts';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { LocalTranscriberPort } from '../../ports/local-transcriber.js';
import { TRANSCRIBER_LEASE_PREFIX } from '../../ports/transcriber-store.js';
import { PUBLIC, type RouteAccess } from '../auth/index.js';
import type { TranscriberStatusBoard } from './transcriber-status.js';

/** Masters only, as the rest of Transcritores (KBC-036 BR-1). */
const MASTER: RouteAccess = { master: true };

/** A status body is small: what it says fits in a few KB (NFR-1). */
const STATUS_BODY_BYTES = 16 * 1024;

export interface TranscriberStatusRouteDeps {
  readonly board: TranscriberStatusBoard;
  /** Only when this API runs on the transcriber's Mac (KB_CHAT_LOCAL_TRANSCRIBER=1). */
  readonly local: LocalTranscriberPort | null;
}

/** What masters read of the transcribers' status, and "Ligar transcritor" (KBC-114). */
export const transcriberStatusRoutes =
  (deps: TranscriberStatusRouteDeps): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get(
      '/api/v1/media/transcribers/status',
      {
        config: { access: MASTER },
        schema: { response: { 200: transcriberStatusOverviewSchema } },
      },
      async () => deps.board.overview(),
    );
    if (deps.local) registerLocalStart(app, deps.local);
  };

/** BR-10: a fixed program with fixed arguments; the route exists only on the Mac. */
function registerLocalStart(
  app: FastifyInstance,
  local: LocalTranscriberPort,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/media/transcribers/local/start',
    {
      config: { access: MASTER },
      schema: { response: { 200: localTranscriberStartSchema } },
    },
    async (request) => {
      const started = await local.start();
      if (!started.ok)
        request.log.warn(
          { detail: started.detail },
          'transcriber: launchctl kickstart failed',
        );
      return started;
    },
  );
}

/**
 * POST /api/v1/media-worker/status (FR-8): a paired transcriber's own status, by its token.
 * Registered inside the workers' scope, whose hook names the token (401 without one); the
 * VM's token has no transcriber to speak for (403).
 */
export function registerWorkerStatus(
  app: FastifyInstance,
  board: TranscriberStatusBoard,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/media-worker/status',
    {
      config: { access: PUBLIC },
      bodyLimit: STATUS_BODY_BYTES,
      schema: {
        body: transcriberStatusReportSchema,
        response: { 204: z.undefined() },
      },
    },
    async (request, reply) => {
      const leaseName = request.workerIdentity?.leaseName ?? null;
      if (!leaseName?.startsWith(TRANSCRIBER_LEASE_PREFIX))
        throw new AppError(
          'FORBIDDEN',
          'Only a paired transcriber has a status',
        );
      board.record(
        leaseName.slice(TRANSCRIBER_LEASE_PREFIX.length),
        request.body,
      );
      return reply.code(204).send();
    },
  );
}
