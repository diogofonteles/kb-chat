import { topicListSchema, type TopicList } from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { CatalogRegistry } from '../catalog/index.js';

export interface TopicsDeps {
  readonly catalog: CatalogRegistry;
  /** Settings' default collection or KB_TOPIC; ignored when it names no topic in the vault. */
  readonly preferredTopic?: string | (() => string | undefined);
}

export function listTopics({
  catalog,
  preferredTopic: preferred,
}: TopicsDeps): TopicList {
  const preferredTopic =
    typeof preferred === 'function' ? preferred() : preferred;
  const items = catalog.topics().map(({ topic, entries }) => ({
    slug: topic.slug,
    title: topic.title,
    documentCount: entries.size,
  }));
  const defaultSlug = items.some((item) => item.slug === preferredTopic)
    ? (preferredTopic ?? null)
    : null;
  return { items, defaultSlug };
}

export const topicRoutes =
  (deps: TopicsDeps): FastifyPluginAsync =>
  async (app) => {
    app
      .withTypeProvider<ZodTypeProvider>()
      .get(
        '/api/v1/topics',
        { schema: { response: { 200: topicListSchema } } },
        async () => listTopics(deps),
      );
  };
