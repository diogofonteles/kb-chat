import {
  aiTestRequestSchema,
  aiTestResultSchema,
  providerListSchema,
  settingsUpdateSchema,
  settingsViewSchema,
  type AiTestRequest,
  type AiTestResult,
  type ProviderList,
} from '@kb-chat/contracts';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { SettingsService } from './settings-service.js';

/** The AI providers as the composition root builds them (ProviderRegistry). */
export interface ProviderCatalog {
  list(principal: string): Promise<ProviderList>;
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
  /** Whose settings: the owner in release 1 (ADR 0005); the signed-in user after ADR 0008. */
  readonly principal: string;
}

/** Each test may spend a few tokens or a subscription message. */
const testLimit = {
  config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
};

/** The body was read, so only the response tells that the client went away. */
function abortOnDisconnect(reply: FastifyReply): AbortSignal {
  const abort = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) abort.abort();
  });
  return abort.signal;
}

function settingsCrud(app: FastifyInstance, options: SettingsRouteOptions) {
  const { settings, principal } = options;
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.get(
    '/api/v1/settings',
    { schema: { response: { 200: settingsViewSchema } } },
    async () => settings.view(principal),
  );
  routes.put(
    '/api/v1/settings',
    {
      schema: {
        body: settingsUpdateSchema,
        response: { 200: settingsViewSchema },
      },
    },
    async (request) => settings.update(principal, request.body),
  );
}

function providerRoutes(app: FastifyInstance, options: SettingsRouteOptions) {
  const { providers, principal } = options;
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.get(
    '/api/v1/ai/providers',
    { schema: { response: { 200: providerListSchema } } },
    async () => providers.list(principal),
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
    async (request, reply) =>
      providers.test(principal, request.body, abortOnDisconnect(reply)),
  );
}

/** GET/PUT /settings, GET /ai/providers and POST /settings/ai/test (KBC-007 FR-2, FR-3). */
export const settingsRoutes =
  (options: SettingsRouteOptions): FastifyPluginAsync =>
  async (app) => {
    settingsCrud(app, options);
    providerRoutes(app, options);
  };
