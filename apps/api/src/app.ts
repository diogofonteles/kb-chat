import { basename } from 'node:path';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { ResearchProfile } from '@kb-chat/contracts';
import type { AppConfig } from './config.js';
import { registerErrorHandler } from './error-handler.js';
import { MemorySpendLedger } from './adapters/memory-spend-ledger.js';
import { CatalogRegistry } from './modules/catalog/index.js';
import { DocumentsService, documentRoutes } from './modules/documents/index.js';
import { researchRoutes } from './modules/research/index.js';
import { SpendService, spendRoutes } from './modules/spend/index.js';
import { healthRoutes } from './modules/health/index.js';
import { searchRoutes } from './modules/search/index.js';
import { topicRoutes } from './modules/topics/index.js';
import authGuard from './plugins/auth-guard.js';
import csrfGuard from './plugins/csrf-guard.js';
import hostGuard from './plugins/host-guard.js';
import routeAccess from './plugins/route-access.js';
import {
  Notifier,
  OWNER_PRINCIPAL,
  OneTimeCodes,
  PeopleService,
  RequestTickets,
  SendLimits,
  SessionService,
  authRoutes,
  codeRoutes,
  peopleRoutes,
} from './modules/auth/index.js';
import {
  AccessRequestService,
  SignUpFlow,
  accessRequestRoutes,
} from './modules/access-requests/index.js';
import { MemoryDocumentStore } from './adapters/memory-document-store.js';
import { MemoryOutbox } from './adapters/memory-outbox.js';
import type { Delivery } from './delivery-factory.js';
import type { DocumentStorePort } from './ports/document-store.js';
import { MemoryPeopleStore } from './adapters/memory-people-store.js';
import { MemorySessionStore } from './adapters/memory-session-store.js';
import { createGoogleVerifier } from './adapters/google-id-token-verifier.js';
import type { IdentityVerifierPort } from './ports/identity-verifier.js';
import type { AgentLlmPort } from './ports/llm.js';
import type { ResearchRunnerPort } from './ports/research-runner.js';
import type { SearchIndexPort } from './ports/search-index.js';
import type { SpendLedgerPort } from './ports/spend-ledger.js';
import type { UsageLogPort } from './ports/usage-log.js';
import type { VaultReaderPort } from './ports/vault-reader.js';
import { MemoryUsageLog } from './adapters/memory-usage-log.js';
import { MemoryConversationStore } from './adapters/memory-conversation-store.js';
import type { ConversationStorePort } from './ports/conversation-store.js';
import {
  ConversationsService,
  conversationRoutes,
} from './modules/conversations/index.js';
import { usageRoutes } from './modules/usage/index.js';
import { createLogger } from './logger.js';
import { MemorySettingsStore } from './adapters/memory-settings-store.js';
import { mcpRoutes } from './mcp/mcp-routes.js';
import { settingsRoutes } from './modules/settings/index.js';
import {
  createAiProviders,
  type AiProviders,
} from './providers/create-ai-providers.js';
import {
  budgetsFromConfig,
  createResearchAgent,
  type ResearchAgent,
} from './research-agent-factory.js';

/** The owner's principal: the alias of the data written before logins (ADR 0008). */
export const OWNER = OWNER_PRINCIPAL;

/** Where one-time codes and access requests are kept and how messages go (ADR 0011). */
export interface AccessDeps {
  readonly codes: DocumentStorePort;
  readonly requests: DocumentStorePort;
  readonly delivery: Delivery;
}

/** Who may sign in and how (ADR 0008); in memory, verifying with Google, when not given. */
export interface AuthDeps {
  readonly people: PeopleService;
  readonly sessions: SessionService;
  readonly verifier: IdentityVerifierPort;
}

export interface AppDeps {
  readonly config: AppConfig;
  readonly vault: VaultReaderPort;
  readonly index: SearchIndexPort;
  /**
   * A fixed model for every research turn (tests with a scripted stub). Without it, each
   * turn takes the runner of the provider in Settings (ai.registry, KBC-007 FR-5).
   */
  readonly llm?: AgentLlmPort;
  readonly ledger?: SpendLedgerPort;
  /** Local usage log (KBC-006); in memory when not given. */
  readonly usage?: UsageLogPort;
  /** Saved conversations (the complete history); in memory when not given. */
  readonly conversations?: ConversationStorePort;
  readonly catalog?: CatalogRegistry;
  readonly logger?: FastifyBaseLogger;
  /** Settings and AI providers (KBC-007); in memory, from the environment, when not given. */
  readonly ai?: AiProviders;
  /**
   * The research tools and loop the providers were built with (main and the E2E server);
   * built here, over `catalog`, when not given.
   */
  readonly agent?: ResearchAgent;
  readonly auth?: AuthDeps;
  /** Codes, requests and delivery (KBC-014); in memory, to an outbox, when not given. */
  readonly access?: AccessDeps;
}

type FullDeps = AppDeps & {
  auth: AuthDeps;
  access: AccessDeps;
  ai: AiProviders;
  agent: ResearchAgent;
  catalog: CatalogRegistry;
  ledger: SpendLedgerPort;
  usage: UsageLogPort;
  conversations: ConversationStorePort;
};

/**
 * The research agent (ADR 0006) with the runner of the current provider, asked per turn
 * (ADR 0007), and the spend controls it shares with the side panel: per-token turns check
 * the principal's daily cap from Settings, subscription turns skip the ledger and the cap.
 */
async function registerResearch(
  app: FastifyInstance,
  deps: FullDeps,
): Promise<void> {
  const { ai, agent, ledger, catalog, llm } = deps;
  const scopeOf = (principal: string) => ({
    principal,
    dailyCapUsd: () => ai.registry.dailyCapUsd(principal),
  });
  const runner = (
    principal: string,
    profile: ResearchProfile = 'fast',
  ): ResearchRunnerPort =>
    llm
      ? agent.perTokenRunner(llm, scopeOf(principal))
      : ai.registry.researchRunner(principal, profile);
  const spendFor = (principal: string) =>
    new SpendService({
      llm: llm ?? ai.registry.llm(principal),
      ledger,
      ...scopeOf(principal),
      configured: () => runner(principal).configured(),
    });
  await app.register(
    spendRoutes({ serviceFor: spendFor, ledger, people: () => spenders(deps) }),
  );
  const hasTopic = (topic: string) => catalog.get(topic) !== undefined;
  await app.register(researchRoutes({ runner, hasTopic }));
}

/** Everyone who has signed in, with the principal their spend is kept under. */
async function spenders(deps: FullDeps) {
  const { people } = deps.auth;
  return (await people.list())
    .filter((person) => person.lastLoginAt !== null)
    .map((person) => ({
      email: person.email,
      principal: people.viewerOf(person).principal,
    }));
}

/** Health, topics (with the Settings default collection) and the free search. */
async function registerSearch(
  app: FastifyInstance,
  deps: FullDeps,
): Promise<void> {
  const { config, index, catalog } = deps;
  await app.register(healthRoutes({ catalog, index }));
  await app.register(
    topicRoutes({
      catalog,
      preferredTopic: (principal) =>
        deps.ai.settings.snapshot(principal)?.preferences.defaultTopic ??
        config.KB_TOPIC,
    }),
  );
  await app.register(
    searchRoutes({
      service: deps.agent.search,
      ratePerMinute: config.SEARCH_RATE_LIMIT,
    }),
  );
}

async function registerRoutes(
  app: FastifyInstance,
  deps: FullDeps,
): Promise<void> {
  const { config, vault, catalog } = deps;
  await registerSearch(app, deps);
  await registerResearch(app, deps);
  const documents = new DocumentsService({
    catalog,
    vault,
    vaultName: config.OBSIDIAN_VAULT ?? basename(config.KB_VAULT),
  });
  await app.register(documentRoutes(documents));
  await app.register(usageRoutes({ catalog, log: deps.usage }));
  const conversations = new ConversationsService({ store: deps.conversations });
  await app.register(conversationRoutes(conversations));
  await registerSettings(app, deps.ai);
  await registerAuth(app, deps);
}

/** The one-time codes, access requests and messages of KBC-014 (ADR 0011). */
function buildAccess(deps: FullDeps) {
  const { access, auth, config } = deps;
  const notifier = new Notifier({
    ...access.delivery,
    webOrigin: config.WEB_ORIGIN,
  });
  const codes = new OneTimeCodes({ store: access.codes });
  const requests = new AccessRequestService({
    store: access.requests,
    people: auth.people,
  });
  const flow = new SignUpFlow({
    requests,
    people: auth.people,
    codes,
    notifier,
  });
  return {
    notifier,
    codes,
    requests,
    flow,
    tickets: new RequestTickets(),
    limits: new SendLimits(),
  };
}

/** Sign-in, who is signed in and "Pessoas e permissões" (KBC-010, ADR 0008; KBC-014). */
async function registerAuth(app: FastifyInstance, deps: FullDeps) {
  const { config, catalog, auth } = deps;
  const topics = () => catalog.topics().map(({ topic }) => topic.slug);
  const access = buildAccess(deps);
  await app.register(
    authRoutes({
      ...auth,
      topics,
      googleClientId: config.GOOGLE_CLIENT_ID ?? null,
      loginRatePerMinute: config.AUTH_RATE_LIMIT,
      codeChannels: access.notifier.smsEnabled ? ['email', 'sms'] : ['email'],
      privacyContactEmail: config.KB_CHAT_OWNER_EMAIL ?? null,
      notInvited: async (identity) => ({
        ticket: access.tickets.issue(identity),
        request: await access.requests.stateFor(identity),
      }),
    }),
  );
  await app.register(peopleRoutes({ ...auth, topics }));
  await registerAccess(app, { deps, access, topics });
}

/** One-time code sign-in and access requests (KBC-014, ADR 0011). */
async function registerAccess(
  app: FastifyInstance,
  wiring: {
    deps: FullDeps;
    access: ReturnType<typeof buildAccess>;
    topics: () => string[];
  },
) {
  const { deps, access, topics } = wiring;
  const rate = deps.config.AUTH_RATE_LIMIT;
  await app.register(
    codeRoutes({ ...deps.auth, ...access, topics, verifyRatePerMinute: rate }),
  );
  await app.register(
    accessRequestRoutes({
      ...access,
      people: deps.auth.people,
      ratePerMinute: rate,
    }),
  );
}

/** Settings, providers and the MCP endpoint of subscription turns (KBC-007, ADR 0007). */
async function registerSettings(
  app: FastifyInstance,
  ai: AiProviders,
): Promise<void> {
  await app.register(
    settingsRoutes({ settings: ai.settings, providers: ai.registry }),
  );
  await app.register(mcpRoutes(ai.turns));
}

/** Settings in memory and providers from the environment only (tests). */
const inMemoryAi = (
  config: AppConfig,
  agent: ResearchAgent,
): Promise<AiProviders> =>
  createAiProviders({
    config,
    store: new MemorySettingsStore(),
    principal: OWNER,
    env: {},
    tools: agent.toolsFor,
    perTokenRunner: agent.perTokenRunner,
    systemPrompt: agent.systemPrompt,
    subAgentPrompt: agent.subAgentPrompt,
  });

const inMemoryAuth = (config: AppConfig): AuthDeps => ({
  people: new PeopleService({
    store: new MemoryPeopleStore(),
    ownerEmail: config.KB_CHAT_OWNER_EMAIL,
  }),
  sessions: new SessionService({ store: new MemorySessionStore() }),
  verifier: createGoogleVerifier(config.GOOGLE_CLIENT_ID ?? ''),
});

const inMemoryAccess = (): AccessDeps => ({
  codes: new MemoryDocumentStore(),
  requests: new MemoryDocumentStore(),
  delivery: { email: new MemoryOutbox(), sms: null },
});

/** Fills what the caller left out: in-memory stores, the agent and the providers. */
async function completeDeps(deps: AppDeps): Promise<FullDeps> {
  const catalog = deps.catalog ?? new CatalogRegistry(deps.vault);
  if (!deps.catalog) await catalog.load();
  const ledger = deps.ledger ?? new MemorySpendLedger();
  const agent =
    deps.agent ??
    createResearchAgent({
      catalog,
      index: deps.index,
      vault: deps.vault,
      ledger,
      budgets: budgetsFromConfig(deps.config),
    });
  return {
    ...deps,
    auth: deps.auth ?? inMemoryAuth(deps.config),
    access: deps.access ?? inMemoryAccess(),
    ai: deps.ai ?? (await inMemoryAi(deps.config, agent)),
    agent,
    catalog,
    ledger,
    usage: deps.usage ?? new MemoryUsageLog(),
    conversations: deps.conversations ?? new MemoryConversationStore(),
  };
}

/** Assembles the API; only `main` listens (ND-01). */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const full = await completeDeps(deps);
  const app = Fastify({
    // Document ids are vault paths; Fastify's default (100 characters) refused 104 real ones.
    maxParamLength: 1024,
    // Behind the reverse proxy (ADR 0010), request.ip comes from X-Forwarded-For.
    trustProxy: deps.config.TRUST_PROXY ?? false,
    loggerInstance: deps.logger ?? createLogger(deps.config.LOG_LEVEL),
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  await app.register(routeAccess);
  await app.register(hostGuard, { allowedHosts: deps.config.ALLOWED_HOSTS });
  await app.register(cors, { origin: [deps.config.WEB_ORIGIN] });
  await app.register(csrfGuard, { webOrigin: deps.config.WEB_ORIGIN });
  await app.register(authGuard, full.auth);
  // The signed-in person's settings are in memory before any route reads them.
  app.addHook('preHandler', async (request) => {
    if (request.viewer) await full.ai.settings.load(request.viewer.principal);
  });
  await app.register(rateLimit, { global: false });
  await registerRoutes(app, full);

  app.addHook('onClose', async () => deps.index.close());
  return app;
}
