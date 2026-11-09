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
import { SIGNED_IN, hasFeature, principalOf, viewerOf } from '../auth/index.js';
import {
  isTrackEntry,
  type CatalogEntry,
  type CatalogRegistry,
} from '../catalog/index.js';
import { topSuggestions } from './suggestions.js';

export interface UsageDeps {
  readonly catalog: CatalogRegistry;
  readonly log: UsageLogPort;
  /** media.db's word on track documents (KBC-101 FR-7); absent with media off. */
  readonly tracks?: () => TrackShelf;
}

/** Texts, and the track documents a shelf confirms in their own collection. */
const seenWith =
  (shelf: TrackShelf | undefined, topic: string) =>
  (entry: CatalogEntry): boolean =>
    !isTrackEntry(entry) ||
    (entry.media !== null &&
      (shelf?.trackOf(topic, entry.media) ?? null) !== null);

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
      const { person } = viewerOf(request);
      const sees =
        hasFeature(person, 'media') && hasFeature(person, 'media-tracks');
      const shelf = sees ? tracks?.() : undefined;
      return topSuggestions(
        scope.flatMap((one) =>
          [...one.entries.values()].filter(seenWith(shelf, one.topic.slug)),
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
