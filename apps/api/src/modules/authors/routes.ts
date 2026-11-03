import {
  authorCreateSchema,
  authorListSchema,
  authorSchema,
  topicSlugSchema,
} from '@kb-chat/contracts';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyPluginAsync,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import { viewerOf, type RouteAccess } from '../auth/index.js';
import type { AuthorsService } from './authors-service.js';

/** Whoever sees the collection reads its authors (the upload field, the filters). */
const READ: RouteAccess = { topicParam: 'topic' };
/** Registering an author is part of sending content there (BR-3). */
const CREATE: RouteAccess = { feature: 'media-upload', topicParam: 'topic' };
const params = z.object({ topic: topicSlugSchema });

export interface AuthorRoutesDeps {
  readonly service: AuthorsService;
  readonly hasTopic: (topic: string) => boolean;
}

type Typed = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

/** The slug of a collection that exists (a master "sees" any slug, even a wrong one). */
const knownTopic = (deps: AuthorRoutesDeps, topic: string): string => {
  if (!deps.hasTopic(topic))
    throw new AppError('TOPIC_NOT_FOUND', `Unknown topic ${topic}`);
  return topic;
};

function registerList(typed: Typed, deps: AuthorRoutesDeps): void {
  typed.get(
    '/api/v1/topics/:topic/authors',
    {
      config: { access: READ },
      schema: { params, response: { 200: authorListSchema } },
    },
    async (request) => ({
      items: deps.service.list(knownTopic(deps, request.params.topic)),
    }),
  );
}

/** 201 for a new author, 200 when the name already is one (same id). */
function registerCreate(typed: Typed, deps: AuthorRoutesDeps): void {
  typed.post(
    '/api/v1/topics/:topic/authors',
    {
      config: { access: CREATE },
      schema: {
        params,
        body: authorCreateSchema,
        response: { 200: authorSchema, 201: authorSchema },
      },
    },
    async (request, reply) => {
      const viewer = viewerOf(request);
      // While acting, the record names the master who did it (ADR 0027).
      const by = (viewer.actor?.viewer ?? viewer).person.email;
      const { author, created } = await deps.service.add(
        knownTopic(deps, request.params.topic),
        request.body,
        by,
      );
      return reply.code(created ? 201 : 200).send(author);
    },
  );
}

/** The authors of a collection (KBC-049 FR-1). */
export const authorRoutes =
  (deps: AuthorRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    registerList(typed, deps);
    registerCreate(typed, deps);
  };
