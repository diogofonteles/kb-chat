import { join } from 'node:path';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { FirecrawlClient } from './adapters/firecrawl-client.js';
import { JsonDocumentStore } from './adapters/json-document-store.js';
import { MemoryDocumentStore } from './adapters/memory-document-store.js';
import { uploadActorOf } from './document-uploads-factory.js';
import type { CatalogRegistry } from './modules/catalog/index.js';
import type { DocumentUploadService } from './modules/document-uploads/index.js';
import {
  WebSearchService,
  webSearchRoutes,
} from './modules/web-search/index.js';
import type { SecretSealerPort } from './ports/secret-sealer.js';

export interface WebSearchOptions {
  /** The state folder; in memory without one (tests). */
  readonly stateDir?: string;
  readonly sealer: SecretSealerPort;
  readonly log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  /** HTTP to Firecrawl (a fake in tests and E2E). */
  readonly fetch?: typeof fetch;
}

/** The web search (KBC-185) with the house's key in web-search.json, loaded. */
export async function createWebSearch(
  options: WebSearchOptions,
): Promise<WebSearchService> {
  const { stateDir, sealer, log } = options;
  const service = new WebSearchService({
    store: stateDir
      ? new JsonDocumentStore(join(stateDir, 'web-search.json'))
      : new MemoryDocumentStore(),
    sealer,
    web: new FirecrawlClient({ fetch: options.fetch }),
    log,
  });
  await service.load();
  return service;
}

/** The search of a collection, next to sending documents: the same people, the same links. */
export async function registerWebSearch(
  app: FastifyInstance,
  wiring: {
    readonly service: WebSearchService;
    readonly catalog: CatalogRegistry;
    readonly uploads: DocumentUploadService;
    readonly perMinute: number;
  },
): Promise<void> {
  const { service, catalog, uploads, perMinute } = wiring;
  await app.register(
    webSearchRoutes({
      service,
      hasTopic: (topic) => catalog.get(topic) !== undefined,
      alreadyOf: (request, topic) => {
        const actor = uploadActorOf(request, catalog);
        return (url) => uploads.presenceOf(actor, topic, url);
      },
      perMinute,
    }),
  );
}
