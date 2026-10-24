import {
  suggestionListSchema,
  topicSlugSchema,
  usageEventRequestSchema,
} from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { UsageLogPort } from '../../ports/usage-log.js';
import type { CatalogRegistry } from '../catalog/index.js';
import { topSuggestions } from './suggestions.js';

export interface UsageDeps {
  readonly catalog: CatalogRegistry;
  readonly log: UsageLogPort;
  /** Who used the app (ADR 0005: the owner until release 2 adds logins). */
  readonly principal: string;
}

const EVENTS_PER_MINUTE = 600;

/** Start suggestions and the local usage log (KBC-006). */
export const usageRoutes =
  ({ catalog, log, principal }: UsageDeps): FastifyPluginAsync =>
  async (app) => {
    const routes = app.withTypeProvider<ZodTypeProvider>();
    routes.get(
      '/api/v1/topics/:topic/suggestions',
      {
        schema: {
          params: z.object({ topic: topicSlugSchema }),
          response: { 200: suggestionListSchema },
        },
      },
      async (request) => {
        const topic = catalog.get(request.params.topic);
        if (!topic)
          throw new AppError(
            'TOPIC_NOT_FOUND',
            `Unknown topic ${request.params.topic}`,
          );
        return topSuggestions(topic.entries.values());
      },
    );
    routes.post(
      '/api/v1/events',
      {
        schema: { body: usageEventRequestSchema },
        config: {
          rateLimit: { max: EVENTS_PER_MINUTE, timeWindow: '1 minute' },
        },
      },
      async (request, reply) => {
        const { sessionId, event } = request.body;
        await log.append({
          ...event,
          ts: new Date().toISOString(),
          principal,
          sessionId,
        });
        return reply.code(202).send();
      },
    );
  };
