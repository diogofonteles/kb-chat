import { topicListSchema, type TopicList } from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { CatalogRegistry } from '../catalog/index.js';

export function listTopics(catalog: CatalogRegistry): TopicList {
  const items = catalog.topics().map(({ topic, entries }) => ({
    slug: topic.slug,
    title: topic.title,
    documentCount: entries.size,
  }));
  return { items };
}

export const topicRoutes =
  (catalog: CatalogRegistry): FastifyPluginAsync =>
  async (app) => {
    app
      .withTypeProvider<ZodTypeProvider>()
      .get(
        '/api/v1/topics',
        { schema: { response: { 200: topicListSchema } } },
        async () => listTopics(catalog),
      );
  };
