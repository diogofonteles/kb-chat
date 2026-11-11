import {
  aiStatusSchema,
  aiTestRequestSchema,
  aiTestResultSchema,
  providerListSchema,
  settingsUpdateSchema,
  settingsViewSchema,
  type AiStatus,
  type AiTestRequest,
  type AiTestResult,
  type ProviderList,
  type SettingsUpdate,
} from '@kb-chat/contracts';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { AppError } from '../../app-error.js';
import {
  SIGNED_IN,
  assertFeature,
  assertNotActing,
  canSee,
  principalOf,
  viewerOf,
  type RouteAccess,
} from '../auth/index.js';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { SettingsService } from './settings-service.js';

/** The AI providers as the composition root builds them (ProviderRegistry). */
export interface ProviderCatalog {
  list(principal: string): Promise<ProviderList>;
  /** Which AI serves the person now and who pays (KBC-022). */
  status(principal: string): Promise<AiStatus>;
  /** A minimal question, bounded by NFR-1's 20 s. */
  test(
    principal: string,
    request: AiTestRequest,
    signal: AbortSignal,
  ): Promise<AiTestResult>;
}

export interface SettingsRouteOptions {
  readonly settings: SettingsService;
  readonly providers: ProviderCatalog;
}

/** Choosing a provider, a key or a model is "Configurações de IA próprias" (KBC-010). */
const OWN_AI: RouteAccess = { feature: 'own-ai-settings' };

/** Each test may spend a few tokens or a subscription message. */
const testLimit = {
  config: {
    access: OWN_AI,
    rateLimit: { max: 10, timeWindow: '1 minute' },
  },
};

const SUBSCRIPTIONS = new Set(['claude-subscription', 'chatgpt-subscription']);

/**
 * Everyone keeps their preferences; the AI part needs own-ai-settings, and only the owner
 * may pick a subscription, which is personal (KBC-007 BR-6).
 */
function assertMayUpdate(
  request: FastifyRequest,
  update: SettingsUpdate,
): void {
  const topic = update.preferences?.defaultTopic;
  if (topic && !canSee(request, topic))
    throw new AppError('VALIDATION_FAILED', 'Unknown collection');
  if (update.ai === undefined) return;
  // The person's own AI (keys, provider, test) is theirs alone (KBC-060 BR-4).
  assertNotActing(request);
  assertFeature(request, 'own-ai-settings');
  const provider = update.ai.provider;
  if (provider && SUBSCRIPTIONS.has(provider) && !viewerOf(request).isOwner)
    throw new AppError('FORBIDDEN', "Subscriptions are the owner's own");
}

/** The invitation's preferences, without a default collection the person no longer sees. */
function visibleInitial(request: FastifyRequest) {
  const initial = viewerOf(request).person.initialPreferences;
  if (!initial?.defaultTopic || canSee(request, initial.defaultTopic))
    return initial;
  return { ...initial, defaultTopic: undefined };
}

/** The body was read, so only the response tells that the client went away. */
function abortOnDisconnect(reply: FastifyReply): AbortSignal {
  const abort = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) abort.abort();
  });
  return abort.signal;
}

function settingsRead(app: FastifyInstance, options: SettingsRouteOptions) {
  const { settings } = options;
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.get(
    '/api/v1/settings',
    {
      config: { access: SIGNED_IN },
      schema: { response: { 200: settingsViewSchema } },
    },
    async (request) =>
      settings.view(principalOf(request), visibleInitial(request)),
  );
}

function settingsUpdate(app: FastifyInstance, options: SettingsRouteOptions) {
  const { settings } = options;
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.put(
    '/api/v1/settings',
    {
      config: { access: SIGNED_IN },
      schema: {
        body: settingsUpdateSchema,
        response: { 200: settingsViewSchema },
      },
    },
    async (request) => {
      assertMayUpdate(request, request.body);
      return settings.update(
        principalOf(request),
        request.body,
        visibleInitial(request),
      );
    },
  );
}

function providerRoutes(app: FastifyInstance, options: SettingsRouteOptions) {
  const { providers } = options;
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.get(
    '/api/v1/ai/providers',
    {
      config: { access: OWN_AI },
      schema: { response: { 200: providerListSchema } },
    },
    async (request) => providers.list(principalOf(request)),
  );
  routes.post(
    '/api/v1/settings/ai/test',
    {
      ...testLimit,
      schema: {
        body: aiTestRequestSchema,
        response: { 200: aiTestResultSchema },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      assertMayUpdate(request, { ai: { provider: request.body.provider } });
      return providers.test(principal, request.body, abortOnDisconnect(reply));
    },
  );
}

/** Which AI serves the person and who pays (KBC-022), for everyone signed in. */
function statusRoute(
  app: FastifyInstance,
  { providers }: SettingsRouteOptions,
) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/v1/ai/status',
    {
      config: { access: SIGNED_IN },
      schema: { response: { 200: aiStatusSchema } },
    },
    async (request) => providers.status(principalOf(request)),
  );
}

/** GET/PUT /settings, GET /ai/providers and POST /settings/ai/test (KBC-007 FR-2, FR-3). */
export const settingsRoutes =
  (options: SettingsRouteOptions): FastifyPluginAsync =>
  async (app) => {
    settingsRead(app, options);
    settingsUpdate(app, options);
    providerRoutes(app, options);
    statusRoute(app, options);
  };
