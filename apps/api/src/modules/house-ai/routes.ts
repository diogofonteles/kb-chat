import {
  OPENROUTER_RETURN_PARAM,
  aiTestResultSchema,
  freeModelListSchema,
  houseAiUpdateSchema,
  houseAiViewSchema,
  houseDefaultSchema,
  openRouterConnectRequestSchema,
  openRouterConnectResponseSchema,
  type Lendable,
  type OpenRouterPurpose,
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
  SIGNED_IN,
  viewerOf,
  type RouteAccess,
  type Viewer,
} from '../auth/index.js';
import type { FreeModelCatalog } from './free-model-catalog.js';
import type { HouseAiService, HouseServiceView } from './house-ai-service.js';
import type { OpenRouterConnect } from './openrouter-connect.js';

/** Who may connect an account for a purpose, and where its key goes (house; KBC-023 adds own). */
export interface ConnectTarget {
  allowed(viewer: Viewer): boolean;
  store(key: string, viewer: Viewer): Promise<void>;
}

export interface HouseAiRouteDeps {
  readonly house: HouseAiService;
  readonly catalog: FreeModelCatalog;
  readonly connect: OpenRouterConnect;
  /** Exchanges an OAuth code for a key (OpenRouter's /auth/keys). */
  readonly exchange: (code: string, verifier: string) => Promise<string>;
  readonly targets: Readonly<Record<OpenRouterPurpose, ConnectTarget>>;
  /** The owner's subscriptions that can be lent now (KBC-024, KBC-027); none when absent. */
  readonly lendable?: () => Lendable;
  /** Codex's sandbox: configured, and whether the owner's login is there (KBC-027). */
  readonly codex?: () => Promise<{
    configured: boolean;
    loggedIn: boolean | null;
  }>;
}

const NOTHING_LENDABLE: Lendable = {
  'claude-subscription': false,
  'chatgpt-subscription': false,
};

const lendable = (deps: HouseAiRouteDeps) => ({
  lendable: deps.lendable?.() ?? NOTHING_LENDABLE,
});

/** The house as masters see it: the service's view, what can be lent and Codex's state. */
async function fullView(deps: HouseAiRouteDeps, view: HouseServiceView) {
  // Codex's state first: what can be lent depends on its login (KBC-027 QA N-2).
  const codex = (await deps.codex?.()) ?? { configured: false, loggedIn: null };
  return {
    ...view,
    ...lendable(deps),
    codex: { ...codex, enabled: deps.house.codexEnabled() },
  };
}

const MASTER: RouteAccess = { master: true };

function registerHouseView(app: FastifyInstance, deps: HouseAiRouteDeps) {
  const { house } = deps;
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.get(
    '/api/v1/house-ai',
    {
      config: { access: MASTER },
      schema: { response: { 200: houseAiViewSchema } },
    },
    async () => fullView(deps, await house.view()),
  );
  routes.put(
    '/api/v1/house-ai',
    {
      config: { access: MASTER },
      schema: {
        body: houseAiUpdateSchema,
        response: { 200: houseAiViewSchema },
      },
    },
    async (request) =>
      fullView(
        deps,
        await house.update(request.body, viewerOf(request).person.email),
      ),
  );
}

function registerHouseDefault(app: FastifyInstance, deps: HouseAiRouteDeps) {
  const { house } = deps;
  const routes = app.withTypeProvider<ZodTypeProvider>();
  // The default alone: "Pessoas e permissões" needs no call to OpenRouter (review fix).
  routes.get(
    '/api/v1/house-ai/default',
    {
      config: { access: MASTER },
      schema: { response: { 200: houseDefaultSchema } },
    },
    async () => {
      // The people screen offers ChatGPT only with its login there (KBC-027 QA N-2).
      await deps.codex?.();
      return { defaultAppAi: house.defaultAppAi(), ...lendable(deps) };
    },
  );
}

function registerHouseKey(app: FastifyInstance, { house }: HouseAiRouteDeps) {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.post(
    '/api/v1/house-ai/test',
    {
      config: {
        access: MASTER,
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
      schema: { response: { 200: aiTestResultSchema } },
    },
    async () => house.test(),
  );
  routes.delete(
    '/api/v1/house-ai/key',
    {
      config: { access: MASTER },
      schema: { response: { 204: z.undefined() } },
    },
    async (_request, reply) => {
      await house.disconnect();
      return reply.code(204).send();
    },
  );
}

const callbackQuery = z.object({
  code: z.string().min(1).max(1024).optional(),
  state: z.string().min(1).max(256).optional(),
});

/** Signed in, and never a master acting as the person (KBC-060 BR-4). */
const NOT_WHILE_ACTING = { notWhileActing: true } as const;

/** Back to the app with the outcome; the target is fixed, never taken from the request. */
const backTo = (outcome: 'connected' | 'error', purpose?: string): string =>
  `/?${OPENROUTER_RETURN_PARAM}=${outcome}${purpose ? `&for=${purpose}` : ''}`;

function registerConnect(app: FastifyInstance, deps: HouseAiRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/openrouter/connect',
    {
      config: {
        // Connecting an account is the person's own (KBC-060 BR-4).
        access: NOT_WHILE_ACTING,
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
      schema: {
        body: openRouterConnectRequestSchema,
        response: { 200: openRouterConnectResponseSchema },
      },
    },
    async (request) => {
      const viewer = viewerOf(request);
      const { purpose } = request.body;
      if (!deps.targets[purpose].allowed(viewer))
        throw new AppError('FORBIDDEN', 'Not allowed to connect this account');
      return { authorizeUrl: deps.connect.start(viewer.principal, purpose) };
    },
  );
}

/** The callback's code and state never reach the log (ADR 0016). */
const withoutQuery = (request: FastifyRequest): string =>
  `${request.method} ${request.url.split('?')[0] ?? ''}`;

function registerCallback(app: FastifyInstance, deps: HouseAiRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/v1/openrouter/callback',
    {
      config: {
        access: NOT_WHILE_ACTING,
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
      schema: { querystring: callbackQuery, response: { 303: z.undefined() } },
    },
    async (request, reply) => {
      const outcome = await completeConnection(deps, {
        viewer: viewerOf(request),
        ...request.query,
      });
      if (outcome.error)
        request.log.warn(
          { reason: outcome.error },
          'openrouter connection failed',
        );
      const target = backTo(
        outcome.error ? 'error' : 'connected',
        outcome.purpose,
      );
      return reply.redirect(target, 303);
    },
  );
}

/** The callback's work: one pending state, the role checked again, the code exchanged. */
async function completeConnection(
  deps: HouseAiRouteDeps,
  input: { viewer: Viewer; code?: string; state?: string },
): Promise<{ purpose?: OpenRouterPurpose; error?: string }> {
  const { viewer, code, state } = input;
  if (!code || !state) return { error: 'missing code or state' };
  const pending = deps.connect.take(state, viewer.principal);
  if (!pending) return { error: 'unknown or expired state' };
  const target = deps.targets[pending.purpose];
  if (!target.allowed(viewer))
    return { purpose: pending.purpose, error: 'not allowed' };
  try {
    const key = await deps.exchange(code, pending.verifier);
    await target.store(key, viewer);
    return { purpose: pending.purpose };
  } catch (err) {
    // The failure's text could carry the code: only its kind is logged.
    const kind = err instanceof Error ? err.name : 'unknown';
    return {
      purpose: pending.purpose,
      error: `code exchange failed (${kind})`,
    };
  }
}

function registerFreeModels(
  app: FastifyInstance,
  { catalog }: HouseAiRouteDeps,
) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/v1/ai/free-models',
    {
      config: { access: SIGNED_IN },
      schema: { response: { 200: freeModelListSchema } },
    },
    async () => catalog.list(),
  );
}

/** "IA da aplicação" (masters), the OpenRouter connection and the free models (KBC-022). */
export const houseAiRoutes =
  (deps: HouseAiRouteDeps): FastifyPluginAsync =>
  async (app) => {
    registerHouseView(app, deps);
    registerHouseDefault(app, deps);
    registerHouseKey(app, deps);
    registerConnect(app, deps);
    registerFreeModels(app, deps);
    await app.register(async (scope) => registerCallback(scope, deps), {
      logSerializers: { req: withoutQuery },
    });
  };
