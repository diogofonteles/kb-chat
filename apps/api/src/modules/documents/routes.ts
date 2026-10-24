import { documentSchema, topicSlugSchema } from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { DocumentsService } from './documents-service.js';

export const documentRoutes =
  (service: DocumentsService): FastifyPluginAsync =>
  async (app) => {
    app.withTypeProvider<ZodTypeProvider>().get(
      '/api/v1/topics/:topic/documents/:id',
      {
        schema: {
          params: z.object({
            topic: topicSlugSchema,
            id: z.string().min(1).max(1024),
          }),
          response: { 200: documentSchema },
        },
      },
      async (request) =>
        service.getDocument(request.params.topic, request.params.id),
    );
  };
