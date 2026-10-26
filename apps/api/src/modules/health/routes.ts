import { healthSchema, type Health } from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { SearchIndexPort } from '../../ports/search-index.js';
import { PUBLIC } from '../auth/index.js';
import type { CatalogRegistry } from '../catalog/index.js';

export interface HealthDeps {
  readonly catalog: CatalogRegistry;
  readonly index: SearchIndexPort;
}

export function readHealth({ catalog, index }: HealthDeps): Health {
  const search = index.status();
  return {
    status: search === 'ok' ? 'ok' : 'degraded',
    search,
    catalog: { documents: catalog.documentCount() },
  };
}

export const healthRoutes =
  (deps: HealthDeps): FastifyPluginAsync =>
  async (app) => {
    app.withTypeProvider<ZodTypeProvider>().get(
      '/health',
      {
        config: { access: PUBLIC },
        schema: { response: { 200: healthSchema } },
      },
      async () => readHealth(deps),
    );
  };
