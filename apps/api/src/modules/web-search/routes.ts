import {
  topicSlugSchema,
  webSearchAvailabilitySchema,
  webSearchKeyRequestSchema,
  webSearchRequestSchema,
  webSearchResponseSchema,
  webSearchSettingsSchema,
} from '@kb-chat/contracts';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import {
  isMaster,
  principalOf,
  viewerOf,
  type RouteAccess,
} from '../auth/index.js';
import type { AlreadyOf, WebSearchService } from './web-search-service.js';

/** Who may send documents searches the web for them (KBC-009 R4: the same permission). */
const SENDER: RouteAccess = { feature: 'media-upload' };
/** Masters connect the house's key; never a master acting as someone. */
const MASTER: RouteAccess = { master: true };
const MASTER_WRITE: RouteAccess = { master: true, notWhileActing: true };

const AVAILABLE = {
  config: { access: SENDER },
  schema: { response: { 200: webSearchAvailabilitySchema } },
};

const searchOptions = (perMinute: number) => ({
  config: {
    access: { ...SENDER, topicParam: 'topic' as const },
    rateLimit: {
      max: perMinute,
      timeWindow: '1 minute',
      // By person, not by address: a household shares one.
      keyGenerator: principalOf,
    },
  },
  schema: {
    params: z.object({ topic: topicSlugSchema }),
    body: webSearchRequestSchema,
    response: { 200: webSearchResponseSchema },
  },
});

export interface WebSearchRouteDeps {
  readonly service: WebSearchService;
  /** The collection exists in the vault. */
  readonly hasTopic: (topic: string) => boolean;
  /** Whether the collection already has a link, for the person asking. */
  readonly alreadyOf: (request: FastifyRequest, topic: string) => AlreadyOf;
  /** Searches one person makes per minute: each costs the house's credits. */
  readonly perMinute: number;
}

/** Searching the web for a collection, and the house's Firecrawl key (KBC-185). */
export const webSearchRoutes =
  (deps: WebSearchRouteDeps): FastifyPluginAsync =>
  async (app) => {
    registerSearch(app, deps);
    registerSettings(app, deps.service);
  };

/** The search, and whether it can be made (no balance: that is the masters'). */
function registerSearch(app: FastifyInstance, deps: WebSearchRouteDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get('/api/v1/web-search/available', AVAILABLE, async () =>
    deps.service.available(),
  );
  typed.post(
    '/api/v1/topics/:topic/web-search',
    searchOptions(deps.perMinute),
    async (request) => {
      const { topic } = request.params;
      if (!deps.hasTopic(topic))
        throw new AppError('TOPIC_NOT_FOUND', `Unknown topic ${topic}`);
      const found = await deps.service.search(
        request.body,
        deps.alreadyOf(request, topic),
      );
      // The balance is the masters' to see.
      return isMaster(viewerOf(request).person)
        ? found
        : { ...found, creditsRemaining: null };
    },
  );
}

function registerSettings(
  app: FastifyInstance,
  service: WebSearchService,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const schema = { response: { 200: webSearchSettingsSchema } };
  typed.get(
    '/api/v1/web-search/settings',
    { config: { access: MASTER }, schema },
    async () => service.settings(),
  );
  typed.put(
    '/api/v1/web-search/settings',
    {
      config: { access: MASTER_WRITE },
      schema: { ...schema, body: webSearchKeyRequestSchema },
    },
    async (request) => service.connect(request.body.key, principalOf(request)),
  );
  typed.delete(
    '/api/v1/web-search/settings',
    { config: { access: MASTER_WRITE }, schema },
    async () => service.disconnect(),
  );
}
