import { topicListSchema, type TopicList } from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { SIGNED_IN, canSee, principalOf } from '../auth/index.js';
import type { CatalogRegistry } from '../catalog/index.js';

export interface TopicsDeps {
  readonly catalog: CatalogRegistry;
  /** Settings' default collection or KB_TOPIC; ignored when it names no topic in the vault. */
  readonly preferredTopic?: (principal: string) => string | undefined;
}

export interface TopicsView {
  readonly preferredTopic?: string;
  /** Which collections the person sees (KBC-010); default: all. */
  readonly visible?: (slug: string) => boolean;
}

export function listTopics(
  { catalog }: Pick<TopicsDeps, 'catalog'>,
  { preferredTopic, visible = () => true }: TopicsView = {},
): TopicList {
  const items = catalog
    .topics()
    .filter(({ topic }) => visible(topic.slug))
    .map(({ topic, entries }) => ({
      slug: topic.slug,
      title: topic.title,
      documentCount: entries.size,
    }));
  const defaultSlug = items.some((item) => item.slug === preferredTopic)
    ? (preferredTopic ?? null)
    : null;
  return { items, defaultSlug };
}

/** The collections the signed-in person may see: the others are not even listed (FR-4). */
export const topicRoutes =
  (deps: TopicsDeps): FastifyPluginAsync =>
  async (app) => {
    app.withTypeProvider<ZodTypeProvider>().get(
      '/api/v1/topics',
      {
        config: { access: SIGNED_IN },
        schema: { response: { 200: topicListSchema } },
      },
      async (request) =>
        listTopics(deps, {
          preferredTopic: deps.preferredTopic?.(principalOf(request)),
          visible: (slug) => canSee(request, slug),
        }),
    );
  };
