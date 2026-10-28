import {
  completeTranscodeRequestSchema,
  failJobRequestSchema,
  heartbeatRequestSchema,
  leaseRequestSchema,
  mediaJobIdSchema,
  workerJobSchema,
} from '@kb-chat/contracts';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import { PUBLIC } from '../auth/index.js';
import type { WorkerService } from './worker-service.js';

const jobParams = z.object({ id: mediaJobIdSchema });
const digest = (value: string) => createHash('sha256').update(value).digest();

/** True when the request carries the worker token (constant-time comparison). */
export function hasWorkerToken(
  request: FastifyRequest,
  token: string,
): boolean {
  const header = request.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  return (
    presented.length > 0 && timingSafeEqual(digest(presented), digest(token))
  );
}

/**
 * The media worker's protocol (ADR 0022 §3): no session, the worker token instead. The
 * routes are public for the session guard; this scope checks the token on every call.
 */
export const workerRoutes =
  (deps: { service: WorkerService; token: string }): FastifyPluginAsync =>
  async (app) => {
    app.addHook('onRequest', async (request) => {
      if (!hasWorkerToken(request, deps.token))
        throw new AppError(
          'UNAUTHENTICATED',
          'A valid worker token is required',
        );
    });
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.post(
      '/api/v1/media-worker/jobs/lease',
      {
        config: { access: PUBLIC },
        schema: {
          body: leaseRequestSchema,
          response: { 200: workerJobSchema, 204: z.undefined() },
        },
      },
      async (request, reply) => {
        const job = deps.service.lease(request.body);
        return job ? reply.code(200).send(job) : reply.code(204).send();
      },
    );
    registerJobRoutes(app, deps.service);
  };

function registerJobRoutes(
  app: Parameters<FastifyPluginAsync>[0],
  service: WorkerService,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/media-worker/jobs/:id/heartbeat',
    route(heartbeatRequestSchema),
    async (request, reply) => {
      service.heartbeat(request.params.id, request.body);
      return reply.code(204).send();
    },
  );
  typed.post(
    '/api/v1/media-worker/jobs/:id/complete',
    route(completeTranscodeRequestSchema),
    async (request, reply) => {
      await service.completeTranscode(request.params.id, request.body);
      return reply.code(204).send();
    },
  );
  typed.post(
    '/api/v1/media-worker/jobs/:id/fail',
    route(failJobRequestSchema),
    async (request, reply) => {
      service.fail(request.params.id, request.body);
      return reply.code(204).send();
    },
  );
}

const route = <T extends z.ZodType>(body: T) => ({
  config: { access: PUBLIC },
  schema: { params: jobParams, body, response: { 204: z.undefined() } },
});
