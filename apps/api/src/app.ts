import { basename, join } from 'node:path';
import { JsonDocumentStore } from './adapters/json-document-store.js';
import {
  InviteProfilesService,
  inviteProfilesRoutes,
} from './modules/invite-profiles/index.js';
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
import {
  LiveTurns,
  TURN_CEILING_MS,
  researchRoutes,
  type ResearchRouteOptions,
} from './modules/research/index.js';
import { SpendService, spendRoutes } from './modules/spend/index.js';
import { healthRoutes } from './modules/health/index.js';
import { searchRoutes } from './modules/search/index.js';
import { topicRoutes } from './modules/topics/index.js';
import authGuard from './plugins/auth-guard.js';
import csrfGuard from './plugins/csrf-guard.js';
import hostGuard from './plugins/host-guard.js';
import routeAccess from './plugins/route-access.js';
import {
  Invitations,
  Notifier,
  OWNER_PRINCIPAL,
  OneTimeCodes,
  PeopleService,
  RequestTickets,
  SendLimits,
  SessionService,
  authRoutes,
  codeRoutes,
  hasFeature,
  invitationRoutes,
  peopleRoutes,
  type StoredPerson,
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
import {
  JANITOR_INTERVAL_MS,
  MediaJanitor,
  MediaService,
  WorkerService,
  mediaRoutes,
  workerRoutes,
} from './modules/media/index.js';
import type { MediaDeps } from './media-factory.js';
import { createLogger } from './logger.js';
import { MemorySettingsStore } from './adapters/memory-settings-store.js';
import { mcpRoutes, peerOnlyMcp } from './mcp/mcp-routes.js';
import { randomBytes } from 'node:crypto';
import { SecretBox } from './adapters/secret-box.js';
import { createHouseAi, type HouseAi } from './house-ai-factory.js';
import { houseAiRoutes } from './modules/house-ai/index.js';
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

/** On shutdown, how long the running research turns get to record how they ended. */
const TURN_SAVE_GRACE_MS = 5_000;

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
  /**
   * The house plan (KBC-022). When not given: in memory, and OpenRouter unreachable (tests
   * never call it); `ai` must then be built with the same `house` to lend it.
   */
  readonly house?: HouseAi;
  /** The media library (ADR 0022); without it no media route exists (KB_CHAT_MEDIA=off). */
  readonly media?: MediaDeps;
}

type FullDeps = AppDeps & {
  auth: AuthDeps;
  house: HouseAi;
  access: AccessDeps;
  ai: AiProviders;
  agent: ResearchAgent;
  catalog: CatalogRegistry;
  ledger: SpendLedgerPort;
  usage: UsageLogPort;
  conversations: ConversationStorePort;
};

/** The runner of a person's turn: a fixed model in tests, else the provider in Settings. */
function researchRunnerOf(deps: FullDeps) {
  const { ai, agent, llm } = deps;
  return (
    principal: string,
    profile: ResearchProfile = 'fast',
  ): ResearchRunnerPort =>
    llm
      ? agent.perTokenRunner(llm, spendScopeOf(deps, principal))
      : ai.registry.researchRunner(principal, profile);
}

const spendScopeOf = (deps: FullDeps, principal: string) => ({
  principal,
  dailyCapUsd: () => deps.ai.registry.dailyCapUsd(principal),
});

/**
 * The research agent (ADR 0006) with the runner of the current provider, asked per turn
 * (ADR 0007), and the spend controls it shares with the side panel: per-token turns check
 * the principal's daily cap from Settings, subscription turns skip the ledger and the cap.
 */
async function registerResearch(
  app: FastifyInstance,
  deps: FullDeps,
  recording: Pick<ResearchRouteOptions, 'turns' | 'journal'>,
): Promise<void> {
  const { ai, ledger, catalog, llm } = deps;
  const runner = researchRunnerOf(deps);
  const spendFor = (principal: string) =>
    new SpendService({
      llm: llm ?? ai.registry.llm(principal),
      ledger,
      ...spendScopeOf(deps, principal),
      configured: () => runner(principal).configured(),
    });
  await app.register(
    spendRoutes({ serviceFor: spendFor, ledger, people: () => spenders(deps) }),
  );
  const hasTopic = (topic: string) => catalog.get(topic) !== undefined;
  await app.register(
    researchRoutes({
      runner,
      hasTopic,
      ratePerMinute: deps.config.RESEARCH_RATE_LIMIT,
      ...recording,
    }),
  );
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
  // Recorded research turns run apart from their request (KBC-029) and land in the history.
  const turns = new LiveTurns();
  const conversations = new ConversationsService({
    store: deps.conversations,
    isLive: (principal, turnId) => turns.isLive(principal, turnId),
    ceilingMs: TURN_CEILING_MS,
  });
  app.addHook('onClose', () => turns.close(TURN_SAVE_GRACE_MS));
  await registerResearch(app, deps, { turns, journal: conversations });
  const documents = new DocumentsService({
    catalog,
    vault,
    vaultName: config.OBSIDIAN_VAULT ?? basename(config.KB_VAULT),
  });
  await app.register(documentRoutes(documents));
  await app.register(usageRoutes({ catalog, log: deps.usage }));
  await app.register(conversationRoutes(conversations));
  await registerSettings(app, deps.ai, deps.config.KB_CHAT_MCP_PEERS);
  await registerAuth(app, deps);
  if (deps.media) await registerMedia(app, { media: deps.media, catalog });
}

/** The media library (KBC-034, ADR 0022): people's routes, the worker's and the janitor. */
async function registerMedia(
  app: FastifyInstance,
  wiring: { media: MediaDeps; catalog: CatalogRegistry },
) {
  const { store, files, workerToken, createPerMinute } = wiring.media;
  const hasTopic = (topic: string) => wiring.catalog.get(topic) !== undefined;
  await app.register(
    mediaRoutes(new MediaService({ store, files, hasTopic }), createPerMinute),
  );
  await app.register(
    workerRoutes({
      service: new WorkerService({ store, files }),
      token: workerToken,
    }),
  );
  const janitor = new MediaJanitor({ store, files, log: app.log });
  janitor.start(JANITOR_INTERVAL_MS);
  app.addHook('onClose', async () => {
    janitor.stop();
    store.close();
  });
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
      mediaEnabled: deps.media !== undefined,
      notInvited: async (identity) => ({
        ticket: access.tickets.issue(identity),
        request: await access.requests.stateFor(identity),
      }),
    }),
  );
  // KBC-026: inviting sends an e-mail through the same notifier as the codes.
  const invitations = new Invitations({
    people: auth.people,
    notifier: access.notifier,
  });
  await registerPeople(app, { deps, topics, invitations });
  await app.register(invitationRoutes({ people: auth.people, invitations }));
  await registerHouse(app, { house: deps.house, ai: deps.ai });
  await registerAccess(app, { deps, access, topics });
}

/** "Pessoas e permissões", with the house reacting to AI changes (KBC-022). */
async function registerPeople(
  app: FastifyInstance,
  wiring: {
    deps: FullDeps;
    topics: () => string[];
    invitations: Invitations;
  },
) {
  const { deps, topics, invitations } = wiring;
  const { house, auth } = deps;
  const profiles = await loadInviteProfiles(deps, (message) =>
    app.log.warn(message),
  );
  await app.register(
    peopleRoutes({
      ...auth,
      topics,
      invitations,
      ai: {
        sync: (person, ai) => house.service.syncPersonKey(person, ai),
        setDefault: (appAi, by) => house.service.setDefault(appAi, by),
      },
      presets: presetsOf(deps, profiles),
    }),
  );
  await app.register(inviteProfilesRoutes(profiles, topics));
}

/** What an invitation and "Aplicar perfil" need from the profiles and Settings (KBC-028). */
const presetsOf = (deps: FullDeps, profiles: InviteProfilesService) => ({
  presetFor: (request: Parameters<InviteProfilesService['presetFor']>[0]) =>
    profiles.presetFor(request),
  hasSavedSettings: (person: StoredPerson) =>
    deps.ai.settings.exists(deps.auth.people.viewerOf(person).principal),
});

/** "Perfis de convite" (KBC-028): invite-profiles.json in the state folder. */
async function loadInviteProfiles(
  deps: FullDeps,
  warn: (message: string) => void,
) {
  const profiles = new InviteProfilesService({
    warn,
    store: new JsonDocumentStore(
      join(deps.config.KB_CHAT_STATE_DIR, 'invite-profiles.json'),
    ),
  });
  await profiles.load();
  return profiles;
}

/** What the owner's subscriptions can do now, for "IA da aplicação" (KBC-024, KBC-027). */
const subscriptionState = (ai: AiProviders) => ({
  lendable: () => ({
    'claude-subscription': ai.lent['claude-subscription'].available(),
    'chatgpt-subscription': ai.lent['chatgpt-subscription'].available(),
  }),
  codex: () => ai.registry.codexStatus(),
});

/** "IA da aplicação", the OpenRouter connection and the free models (KBC-022). */
async function registerHouse(
  app: FastifyInstance,
  { house, ai }: { house: HouseAi; ai: AiProviders },
) {
  const { settings } = ai;
  await app.register(
    houseAiRoutes({
      ...subscriptionState(ai),
      house: house.service,
      catalog: house.catalog,
      connect: house.connect,
      exchange: (code, verifier) => house.account.exchangeCode(code, verifier),
      targets: {
        house: {
          allowed: (viewer) => viewer.person.role === 'master',
          store: (key, viewer) =>
            house.service.connect(key, viewer.person.email),
        },
        // One's own OpenRouter (KBC-023): stored sealed in the person's settings.
        own: {
          allowed: (viewer) => hasFeature(viewer.person, 'own-ai-settings'),
          store: async (key, viewer) => {
            await settings.connectOpenRouter(viewer.principal, key);
          },
        },
      },
    }),
  );
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
    codeRoutes({
      ...deps.auth,
      ...access,
      topics,
      verifyRatePerMinute: rate,
      mediaEnabled: deps.media !== undefined,
    }),
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
  mcpPeers: readonly string[],
): Promise<void> {
  await app.register(
    settingsRoutes({ settings: ai.settings, providers: ai.registry }),
  );
  await app.register(mcpRoutes(ai.turns, { peers: mcpPeers }));
}

/** Settings in memory and providers from the environment only (tests). */
const inMemoryAi = (
  config: AppConfig,
  wiring: {
    agent: ResearchAgent;
    house: HouseAi;
    auth: AuthDeps;
    ledger: SpendLedgerPort;
  },
): Promise<AiProviders> =>
  createAiProviders({
    config,
    store: new MemorySettingsStore(),
    principal: OWNER,
    env: {},
    tools: wiring.agent.toolsFor,
    perTokenRunner: wiring.agent.perTokenRunner,
    systemPrompt: wiring.agent.systemPrompt,
    house: wiring.house,
    personOf: (principal) => wiring.auth.people.cachedByPrincipal(principal),
    ledger: wiring.ledger,
  });

/** OpenRouter never answers in a test that did not bring its own fake. */
const offline: typeof fetch = async () => {
  throw new Error('No network in tests');
};

const inMemoryHouse = (config: AppConfig): Promise<HouseAi> =>
  createHouseAi({
    sealer: new SecretBox(randomBytes(32)),
    webOrigin: config.WEB_ORIGIN,
    fetch: offline,
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
  const auth = deps.auth ?? inMemoryAuth(deps.config);
  const house = deps.house ?? (await inMemoryHouse(deps.config));
  return {
    ...deps,
    auth,
    house,
    access: deps.access ?? inMemoryAccess(),
    ai:
      deps.ai ??
      (await inMemoryAi(deps.config, { agent, house, auth, ledger })),
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

  // The Codex sandbox reaches only the MCP routes (KBC-027, ADR 0020).
  app.addHook('onRequest', peerOnlyMcp(deps.config.KB_CHAT_MCP_PEERS));
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
