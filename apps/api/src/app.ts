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
import { CatalogRegistry } from './modules/catalog/index.js';
import { DocumentsService, documentRoutes } from './modules/documents/index.js';
import { healthRoutes } from './modules/health/index.js';
import { SearchService, searchRoutes } from './modules/search/index.js';
import { topicRoutes } from './modules/topics/index.js';
import hostGuard from './plugins/host-guard.js';
import type { SearchIndexPort } from './ports/search-index.js';
import type { VaultReaderPort } from './ports/vault-reader.js';
import { createLogger } from './logger.js';

export interface AppDeps {
  readonly config: AppConfig;
  readonly vault: VaultReaderPort;
  readonly index: SearchIndexPort;
  readonly catalog?: CatalogRegistry;
  readonly logger?: FastifyBaseLogger;
}

async function registerRoutes(
  app: FastifyInstance,
  deps: AppDeps & { catalog: CatalogRegistry },
): Promise<void> {
  const { config, vault, index, catalog } = deps;
  await app.register(healthRoutes({ catalog, index }));
  await app.register(topicRoutes({ catalog, preferredTopic: config.KB_TOPIC }));
  await app.register(
    searchRoutes({
      service: new SearchService({ catalog, index, vault }),
      ratePerMinute: config.SEARCH_RATE_LIMIT,
    }),
  );
  await app.register(
    documentRoutes(
      new DocumentsService({
        catalog,
        vault,
        vaultName: config.OBSIDIAN_VAULT ?? basename(config.KB_VAULT),
      }),
    ),
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
  await registerRoutes(app, { ...deps, catalog });

  app.addHook('onClose', async () => deps.index.close());
  return app;
}
