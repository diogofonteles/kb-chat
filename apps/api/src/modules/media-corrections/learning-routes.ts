import {
  learningSwitchParamsSchema,
  learningSwitchRequestSchema,
  transcriptLearningSchema,
} from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { principalOf, viewerOf, type RouteAccess } from '../auth/index.js';
import type { LearningService } from './learning-service.js';

/** Only masters see and switch what was learned (KBC-113 BR-11), as the term list. */
const MASTER: RouteAccess = { master: true };

const SWITCH = {
  config: { access: MASTER },
  schema: {
    params: learningSwitchParamsSchema,
    body: learningSwitchRequestSchema,
    response: { 200: transcriptLearningSchema },
  },
} as const;

/** "Aprendido das correções" in Termos da transcrição (KBC-113 FR-2, FR-3). */
export const learningRoutes =
  (service: LearningService): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get(
      '/api/v1/media/learning',
      {
        config: { access: MASTER },
        schema: { response: { 200: transcriptLearningSchema } },
      },
      async () => service.overview(),
    );
    typed.put('/api/v1/media/learning/rules/:id', SWITCH, async (request) =>
      service.switchRule(request.params.id, request.body.enabled, {
        principal: principalOf(request),
        name: viewerOf(request).person.name,
      }),
    );
    typed.put('/api/v1/media/learning/terms/:id', SWITCH, async (request) =>
      service.switchTerm(request.params.id, request.body.enabled, {
        principal: principalOf(request),
        name: viewerOf(request).person.name,
      }),
    );
  };
