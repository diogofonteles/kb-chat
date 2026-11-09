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
import type { TrackShelf } from '../../ports/track-shelf.js';
import {
  SIGNED_IN,
  principalOf,
  seesTrackDocuments,
  viewerOf,
} from '../auth/index.js';
import { isSeenDocument, type CatalogRegistry } from '../catalog/index.js';
import { topSuggestions } from './suggestions.js';

export interface UsageDeps {
  readonly catalog: CatalogRegistry;
  readonly log: UsageLogPort;
  /** media.db's word on track documents (KBC-101 FR-7); absent with media off. */
  readonly tracks?: () => TrackShelf;
}

const EVENTS_PER_MINUTE = 600;

const suggestionsSchema = {
  params: z.object({ topic: topicSlugSchema }),
  response: { 200: suggestionListSchema },
};

function registerSuggestions(
  app: FastifyInstance,
  { catalog, tracks }: UsageDeps,
) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/v1/topics/:topic/suggestions',
    {
      config: { access: { topicParam: 'topic' } },
      schema: suggestionsSchema,
    },
    async (request) => {
      const { topic } = request.params;
      // A parent suggests from its sub-collections too (ADR 0028).
      const scope = catalog.scope(topic);
      if (scope.length === 0)
        throw new AppError('TOPIC_NOT_FOUND', `Unknown topic ${topic}`);
      // A track's concepts count for who sees tracks as documents (KBC-101 BR-7).
      const sees = seesTrackDocuments(viewerOf(request).person);
      const shelf = sees ? tracks?.() : undefined;
      return topSuggestions(
        scope.flatMap((one) =>
          [...one.entries.values()].filter((entry) =>
            isSeenDocument(entry, {
              topic: one.topic.slug,
              tracks: shelf,
            }),
          ),
        ),
      );
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
