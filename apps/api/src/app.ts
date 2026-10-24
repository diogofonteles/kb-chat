import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
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

export interface AppDeps {
  readonly config: AppConfig;
  readonly vault: VaultReaderPort;
  readonly index: SearchIndexPort;
  readonly catalog?: CatalogRegistry;
}

/** Assembles the API; only `main` listens (ND-01). */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, vault, index } = deps;
  const catalog = deps.catalog ?? new CatalogRegistry(vault);
  if (!deps.catalog) await catalog.load();

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  await app.register(hostGuard, { allowedHosts: config.ALLOWED_HOSTS });
  await app.register(cors, { origin: [config.WEB_ORIGIN] });
  await app.register(healthRoutes({ catalog, index }));
  await app.register(topicRoutes(catalog));
  await app.register(
    searchRoutes(new SearchService({ catalog, index, vault })),
  );
  await app.register(documentRoutes(new DocumentsService({ catalog, vault })));

  app.addHook('onClose', async () => index.close());
  return app;
}
