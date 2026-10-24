import {
  documentSchema,
  relationPageSchema,
  seeAlsoGroupNameSchema,
  topicSlugSchema,
} from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteAccess } from '../auth/index.js';
import type { DocumentsService } from './documents-service.js';

/** Reading needs only the collection: research answers cite documents too (KBC-010). */
const READ_ACCESS: RouteAccess = { topicParam: 'topic' };

const documentParams = z.object({
  topic: topicSlugSchema,
  id: z.string().min(1).max(1024),
});

const relationsQuery = z.object({
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const documentRoutes =
  (service: DocumentsService): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get(
      '/api/v1/topics/:topic/documents/:id',
      {
        config: { access: READ_ACCESS },
        schema: { params: documentParams, response: { 200: documentSchema } },
      },
      async (request) =>
        service.getDocument(request.params.topic, request.params.id),
    );
    typed.get(
      '/api/v1/topics/:topic/documents/:id/relations/:group',
      {
        config: { access: READ_ACCESS },
        schema: {
          params: documentParams.extend({ group: seeAlsoGroupNameSchema }),
          querystring: relationsQuery,
          response: { 200: relationPageSchema },
        },
      },
      async (request) => {
        const { topic, id, group } = request.params;
        return service.relationPage(topic, id, { group, ...request.query });
      },
    );
  };
