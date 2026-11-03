import {
  topicCreateSchema,
  topicListSchema,
  topicSchema,
  topicSlugSchema,
  topicUpdateSchema,
} from '@kb-chat/contracts';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  SIGNED_IN,
  canSee,
  hasFeature,
  isMaster,
  principalOf,
  viewerOf,
  type RouteAccess,
} from '../auth/index.js';
import {
  listTopics,
  type CollectionActor,
  type TopicsService,
  type TopicsServiceDeps,
} from './topics-service.js';

export interface TopicsDeps {
  readonly catalog: TopicsServiceDeps['catalog'];
  readonly service: TopicsService;
  /** Settings' default collection or KB_TOPIC; ignored when it names no topic in the vault. */
  readonly preferredTopic?: (principal: string) => string | undefined;
}

/** "Criar acervos" creates and renames (KBC-048 BR-1); renaming also needs the collection. */
const CREATE: RouteAccess = { feature: 'collection-create' };
const RENAME: RouteAccess = { ...CREATE, topicParam: 'topic' };

const actorOf = (request: FastifyRequest): CollectionActor => {
  const viewer = viewerOf(request);
  return {
    personId: viewer.person.id,
    personEmail: viewer.person.email,
    isMaster: isMaster(viewer.person),
    // While acting, the records name the master who did it (ADR 0027).
    email: (viewer.actor?.viewer ?? viewer).person.email,
    canSee: (slug) => canSee(request, slug),
  };
};

type Typed = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

/** The collections the signed-in person may see: the others are not even listed (FR-4). */
function registerList(typed: Typed, deps: TopicsDeps): void {
  typed.get(
    '/api/v1/topics',
    {
      config: { access: SIGNED_IN },
      schema: { response: { 200: topicListSchema } },
    },
    async (request) =>
      listTopics(deps, {
        preferredTopic: deps.preferredTopic?.(principalOf(request)),
        visible: (slug) => canSee(request, slug),
        renamable: hasFeature(viewerOf(request).person, 'collection-create')
          ? await deps.service.renamableBy(actorOf(request))
          : undefined,
      }),
  );
}

/** Creating and renaming on the screen (KBC-048 FR-1, FR-2). */
function registerChanges(typed: Typed, { service }: TopicsDeps): void {
  typed.post(
    '/api/v1/topics',
    {
      config: { access: CREATE },
      schema: { body: topicCreateSchema, response: { 201: topicSchema } },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(await service.create(actorOf(request), request.body)),
  );
  typed.patch(
    '/api/v1/topics/:topic',
    {
      config: { access: RENAME },
      schema: {
        params: z.object({ topic: topicSlugSchema }),
        body: topicUpdateSchema,
        response: { 200: topicSchema },
      },
    },
    async (request) =>
      service.rename(actorOf(request), request.params.topic, request.body),
  );
}

export const topicRoutes =
  (deps: TopicsDeps): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    registerList(typed, deps);
    registerChanges(typed, deps);
  };
