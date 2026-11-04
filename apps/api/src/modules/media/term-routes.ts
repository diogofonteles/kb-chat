import {
  measureTermsRequestSchema,
  saveTermsRequestSchema,
  termListSchema,
  termsUsageSchema,
} from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { principalOf, viewerOf, type RouteAccess } from '../auth/index.js';
import type { TermListService } from './term-list-service.js';

/** BR-1: only masters read and change the list here; a transcriber has its worker route. */
const MASTER: RouteAccess = { master: true };

const OPTIONS = {
  list: {
    config: { access: MASTER },
    schema: { response: { 200: termListSchema } },
  },
  save: {
    config: { access: MASTER },
    schema: {
      body: saveTermsRequestSchema,
      response: { 200: termListSchema },
    },
  },
  measure: {
    config: { access: MASTER },
    schema: {
      body: measureTermsRequestSchema,
      response: { 200: termsUsageSchema },
    },
  },
} as const;

/** "Termos da transcrição" (KBC-040 FR-1, FR-2). */
export const termRoutes =
  (service: TermListService): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get('/api/v1/media/terms', OPTIONS.list, async () => service.list());
    typed.put('/api/v1/media/terms', OPTIONS.save, async (request) =>
      service.save(request.body, {
        principal: principalOf(request),
        name: viewerOf(request).person.name,
      }),
    );
    typed.post('/api/v1/media/terms/measure', OPTIONS.measure, async (request) =>
      service.measure(request.body.terms),
    );
  };
