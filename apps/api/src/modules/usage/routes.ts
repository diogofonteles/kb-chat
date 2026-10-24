import {
  suggestionListSchema,
  topicSlugSchema,
  usageEventRequestSchema,
} from '@kb-chat/contracts';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { UsageLogPort } from '../../ports/usage-log.js';
import { SIGNED_IN, principalOf } from '../auth/index.js';
import type { CatalogRegistry } from '../catalog/index.js';
import { topSuggestions } from './suggestions.js';

export interface UsageDeps {
  readonly catalog: CatalogRegistry;
  readonly log: UsageLogPort;
}

const EVENTS_PER_MINUTE = 600;

const suggestionsSchema = {
  params: z.object({ topic: topicSlugSchema }),
  response: { 200: suggestionListSchema },
};

function registerSuggestions(app: FastifyInstance, { catalog }: UsageDeps) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/v1/topics/:topic/suggestions',
    {
      config: { access: { topicParam: 'topic' } },
      schema: suggestionsSchema,
    },
    async ({ params }) => {
      const topic = catalog.get(params.topic);
      if (!topic)
        throw new AppError('TOPIC_NOT_FOUND', `Unknown topic ${params.topic}`);
      return topSuggestions(topic.entries.values());
    },
  );
}

function registerEvents(app: FastifyInstance, { log }: UsageDeps) {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/events',
    {
      schema: {
        body: usageEventRequestSchema,
        response: { 202: z.undefined() },
      },
      config: {
        access: SIGNED_IN,
        rateLimit: { max: EVENTS_PER_MINUTE, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const { sessionId, event } = request.body;
      const principal = principalOf(request);
      const ts = new Date().toISOString();
      await log.append({ ...event, ts, principal, sessionId });
      return reply.code(202).send();
    },
  );
}

/** Start suggestions and the local usage log (KBC-006). */
export const usageRoutes =
  (deps: UsageDeps): FastifyPluginAsync =>
  async (app) => {
    registerSuggestions(app, deps);
    registerEvents(app, deps);
  };
