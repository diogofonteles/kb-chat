import {
  documentRemovalListSchema,
  documentRemovalSchema,
  documentRestoreSchema,
  topicSlugSchema,
} from '@kb-chat/contracts';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RemovalActor, RemovalService } from './removal-service.js';

export interface DocumentRemovalRouteDeps {
  readonly service: RemovalService;
  readonly actorOf: (request: FastifyRequest) => RemovalActor;
}

const config = { access: { master: true } } as const;
const removalParams = z.object({ id: z.uuid() });
const documentParams = z.object({
  topic: topicSlugSchema,
  id: z.string().min(1).max(1024),
});

/** A document out of its collection, and back (KBC-187): masters. */
export const documentRemovalRoutes =
  (deps: DocumentRemovalRouteDeps): FastifyPluginAsync =>
  async (app) => {
    registerRemove(app, deps);
    registerRestore(app, deps);
    registerRetry(app, deps);
  };

function registerRemove(app: FastifyInstance, deps: DocumentRemovalRouteDeps) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/topics/:topic/documents/:id/removal',
    {
      config: { access: { ...config.access, topicParam: 'topic' } },
      schema: {
        params: documentParams,
        response: { 200: documentRemovalSchema },
      },
    },
    async (request) =>
      deps.service.remove(
        deps.actorOf(request),
        request.params.topic,
        request.params.id,
      ),
  );
  typed.get(
    '/api/v1/document-removals',
    { config, schema: { response: { 200: documentRemovalListSchema } } },
    async (request) => ({ items: deps.service.list(deps.actorOf(request)) }),
  );
}

function registerRestore(app: FastifyInstance, deps: DocumentRemovalRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/document-removals/:id/restore',
    {
      config,
      schema: {
        params: removalParams,
        response: { 200: documentRestoreSchema },
      },
    },
    async (request) => ({
      removal: await deps.service.restore(
        deps.actorOf(request),
        request.params.id,
      ),
    }),
  );
}

function registerRetry(app: FastifyInstance, deps: DocumentRemovalRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/document-removals/:id/retry',
    {
      config,
      schema: {
        params: removalParams,
        response: { 200: documentRemovalSchema },
      },
    },
    async (request) =>
      deps.service.retry(deps.actorOf(request), request.params.id),
  );
}
