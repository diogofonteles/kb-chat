import {
  documentSchema,
  relationPageSchema,
  seeAlsoGroupNameSchema,
  topicSlugSchema,
} from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { DocumentsService } from './documents-service.js';

const documentParams = z.object({
  topic: topicSlugSchema,
  id: z.string().min(1).max(1024),
});

export const documentRoutes =
  (service: DocumentsService): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get(
      '/api/v1/topics/:topic/documents/:id',
      { schema: { params: documentParams, response: { 200: documentSchema } } },
      async (request) =>
        service.getDocument(request.params.topic, request.params.id),
    );
    typed.get(
      '/api/v1/topics/:topic/documents/:id/relations/:group',
      {
        schema: {
          params: documentParams.extend({ group: seeAlsoGroupNameSchema }),
          querystring: z.object({
            offset: z.coerce.number().int().min(0).max(100_000).default(0),
            limit: z.coerce.number().int().min(1).max(50).default(20),
          }),
          response: { 200: relationPageSchema },
        },
      },
      async (request) => {
        const { topic, id, group } = request.params;
        return service.relationPage(topic, id, { group, ...request.query });
      },
    );
  };
