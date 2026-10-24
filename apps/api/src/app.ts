import { basename } from 'node:path';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { AppConfig } from './config.js';
import { registerErrorHandler } from './error-handler.js';
import { DisabledLlm } from './adapters/disabled-llm.js';
import { MemorySpendLedger } from './adapters/memory-spend-ledger.js';
import { CatalogRegistry } from './modules/catalog/index.js';
import { AnswersService, answerRoutes } from './modules/answers/index.js';
import { DocumentsService, documentRoutes } from './modules/documents/index.js';
import { healthRoutes } from './modules/health/index.js';
import { SearchService, searchRoutes } from './modules/search/index.js';
import { topicRoutes } from './modules/topics/index.js';
import hostGuard from './plugins/host-guard.js';
import type { LlmPort } from './ports/llm.js';
import type { SearchIndexPort } from './ports/search-index.js';
import type { SpendLedgerPort } from './ports/spend-ledger.js';
import type { UsageLogPort } from './ports/usage-log.js';
import type { VaultReaderPort } from './ports/vault-reader.js';
import { MemoryUsageLog } from './adapters/memory-usage-log.js';
import { usageRoutes } from './modules/usage/index.js';
import { createLogger } from './logger.js';

/** The only principal until release 2 adds logins (ADR 0005). */
export const OWNER = 'owner';

/** Usage events older than this are removed when the API starts (KBC-006 BR-3). */
export const USAGE_RETENTION_DAYS = 90;

export interface AppDeps {
  readonly config: AppConfig;
  readonly vault: VaultReaderPort;
  readonly index: SearchIndexPort;
  /** AI provider; without one, answers are disabled (LLM_NOT_CONFIGURED). */
  readonly llm?: LlmPort;
  readonly ledger?: SpendLedgerPort;
  /** Local usage log (KBC-006); in memory when not given. */
  readonly usage?: UsageLogPort;
  readonly catalog?: CatalogRegistry;
  readonly logger?: FastifyBaseLogger;
}

type FullDeps = AppDeps & {
  catalog: CatalogRegistry;
  llm: LlmPort;
  ledger: SpendLedgerPort;
  usage: UsageLogPort;
};

async function registerAnswers(
  app: FastifyInstance,
  deps: FullDeps,
  search: SearchService,
): Promise<void> {
  const { config, vault, llm, ledger } = deps;
  const service = new AnswersService({
    search,
    vault,
    llm,
    ledger,
    dailyCapUsd: config.KB_CHAT_DAILY_CAP_USD,
    principal: OWNER,
  });
  const spendToday = async () => ({
    usd: await ledger.spentToday(OWNER),
    capUsd: config.KB_CHAT_DAILY_CAP_USD,
    configured: llm.configured(),
  });
  await app.register(answerRoutes({ service, spendToday }));
}

async function registerRoutes(
  app: FastifyInstance,
  deps: FullDeps,
): Promise<void> {
  const { config, vault, index, catalog } = deps;
  await app.register(healthRoutes({ catalog, index }));
  await app.register(topicRoutes({ catalog, preferredTopic: config.KB_TOPIC }));
  const search = new SearchService({ catalog, index, vault });
  await app.register(
    searchRoutes({ service: search, ratePerMinute: config.SEARCH_RATE_LIMIT }),
  );
  await registerAnswers(app, deps, search);
  const documents = new DocumentsService({
    catalog,
    vault,
    vaultName: config.OBSIDIAN_VAULT ?? basename(config.KB_VAULT),
  });
  await app.register(documentRoutes(documents));
  await app.register(
    usageRoutes({ catalog, log: deps.usage, principal: OWNER }),
  );
}

/** Assembles the API; only `main` listens (ND-01). */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const catalog = deps.catalog ?? new CatalogRegistry(deps.vault);
  if (!deps.catalog) await catalog.load();

  const app = Fastify({
    // Document ids are vault paths; Fastify's default (100 characters) refused 104 real ones.
    maxParamLength: 1024,
    loggerInstance: deps.logger ?? createLogger(deps.config.LOG_LEVEL),
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  await app.register(hostGuard, { allowedHosts: deps.config.ALLOWED_HOSTS });
  await app.register(cors, { origin: [deps.config.WEB_ORIGIN] });
  await app.register(rateLimit, { global: false });
  await registerRoutes(app, {
    ...deps,
    catalog,
    llm: deps.llm ?? new DisabledLlm(),
    ledger: deps.ledger ?? new MemorySpendLedger(),
    usage: deps.usage ?? new MemoryUsageLog(),
  });

  app.addHook('onClose', async () => deps.index.close());
  return app;
}
