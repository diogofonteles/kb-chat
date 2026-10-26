import {
  conversationIdSchema,
  conversationListSchema,
  conversationSchema,
  conversationSummarySchema,
} from '@kb-chat/contracts';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import { SIGNED_IN, principalOf } from '../auth/index.js';
import type { ConversationsService } from './conversations-service.js';

/** A long research conversation (answers and sources) outgrows Fastify's 1 MB default. */
const MAX_CONVERSATION_BYTES = 16 * 1024 * 1024;

const params = z.object({ id: conversationIdSchema });
const listQuery = z.object({
  kind: z.enum(['search', 'research']).optional(),
  topic: z.string().min(1).max(200).optional(),
});

function registerReads(app: FastifyInstance, service: ConversationsService) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    '/api/v1/conversations',
    {
      config: { access: SIGNED_IN },
      schema: {
        querystring: listQuery,
        response: { 200: conversationListSchema },
      },
    },
    async (request) => ({
      items: await service.list(principalOf(request), request.query),
    }),
  );
  typed.get(
    '/api/v1/conversations/:id',
    {
      config: { access: SIGNED_IN },
      schema: { params, response: { 200: conversationSchema } },
    },
    async (request) => {
      const { id } = request.params;
      const conversation = await service.get(principalOf(request), id);
      if (!conversation)
        throw new AppError('NOT_FOUND', `Unknown conversation ${id}`);
      return conversation;
    },
  );
}

function registerWrites(app: FastifyInstance, service: ConversationsService) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.put(
    '/api/v1/conversations/:id',
    {
      bodyLimit: MAX_CONVERSATION_BYTES,
      config: { access: SIGNED_IN },
      schema: {
        params,
        body: conversationSchema,
        response: { 200: conversationSummarySchema },
      },
    },
    async (request) => {
      const { body } = request;
      if (body.id !== request.params.id)
        throw new AppError(
          'VALIDATION_FAILED',
          'The body id must match the path id',
        );
      return service.save(principalOf(request), body);
    },
  );
}

function registerRemove(app: FastifyInstance, service: ConversationsService) {
  app.withTypeProvider<ZodTypeProvider>().delete(
    '/api/v1/conversations/:id',
    {
      config: { access: SIGNED_IN },
      schema: { params, response: { 204: z.undefined() } },
    },
    // Idempotent: removing a conversation that is already gone is not an error.
    async (request, reply) => {
      await service.remove(principalOf(request), request.params.id);
      return reply.code(204).send();
    },
  );
}

/** The complete conversation history (KBC-005 history, KBC-008 FR-6). */
export const conversationRoutes =
  (service: ConversationsService): FastifyPluginAsync =>
  async (app) => {
    registerReads(app, service);
    registerWrites(app, service);
    registerRemove(app, service);
  };
