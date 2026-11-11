import {
  bulkLevelRequestSchema,
  bulkLevelResultSchema,
  documentLevelSchema,
  levelChoicesSchema,
  unassignedCountsSchema,
  unassignedPageSchema,
  unassignedQuerySchema,
  documentLevelUpdateSchema,
  levelCreateSchema,
  levelRefSchema,
  levelOrderSchema,
  levelRenameSchema,
  levelScalesSchema,
  topicLevelsSchema,
  topicSlugSchema,
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
import { viewerOf, type RouteAccess } from '../auth/index.js';
import type {
  AccessLevelsService,
  LevelActor,
} from './access-levels-service.js';
import type {
  Classifier,
  DocumentLevelsService,
} from './document-levels-service.js';

/** Masters only (BR-9: `collection-levels`), in a collection they see (404 otherwise). */
const MANAGE: RouteAccess = {
  topicParam: 'topic',
  feature: 'collection-levels',
};

/**
 * Masters and holders of "Classificar nível de conteúdo" (KBC-107 BR-1, BR-2), in a
 * collection they see (404 otherwise).
 */
const CLASSIFY: RouteAccess = {
  topicParam: 'topic',
  feature: 'content-levels',
};

const topicParams = z.object({ topic: topicSlugSchema });
const levelParams = topicParams.extend({ level: levelRefSchema });
const documentParams = topicParams.extend({
  id: z.string().min(1).max(1024),
});

/** The master who writes; while acting, the person too (ADR 0027). */
const actorOf = (request: FastifyRequest): LevelActor => {
  const viewer = viewerOf(request);
  const real = viewer.actor?.viewer ?? viewer;
  return {
    by: real.person.email,
    ...(viewer.actor && { actingAs: viewer.person.email }),
  };
};

/** The person whose level applies (the one a master acts as) and the audit's names. */
const classifierOf = (request: FastifyRequest): Classifier => ({
  actor: actorOf(request),
  person: viewerOf(request).person,
});

type Typed = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

const LEVELS_URL = '/api/v1/topics/:topic/levels';
const config = { access: MANAGE };
const ok = { 200: topicLevelsSchema };

/** Every scale, as choices for the person editor (T9). */
function registerScales(typed: Typed, service: AccessLevelsService): void {
  typed.get(
    '/api/v1/levels',
    {
      config: { access: { feature: 'collection-levels' } },
      schema: { response: { 200: levelScalesSchema } },
    },
    async () => service.scales(),
  );
}

/** The scale: read it, add a level (FR-1, FR-2). */
function registerScale(typed: Typed, service: AccessLevelsService): void {
  typed.get(
    LEVELS_URL,
    { config, schema: { params: topicParams, response: ok } },
    async (request) => service.levelsOf(request.params.topic),
  );
  typed.post(
    LEVELS_URL,
    {
      config,
      schema: {
        params: topicParams,
        body: levelCreateSchema,
        response: { 201: topicLevelsSchema },
      },
    },
    async (request, reply) => {
      const { params, body } = request;
      const levels = await service.create(actorOf(request), params.topic, body);
      return reply.code(201).send(levels);
    },
  );
}

/** Reorder the scale and rename a level (FR-1, AC-11, AC-12). */
function registerChanges(typed: Typed, service: AccessLevelsService): void {
  typed.patch(
    LEVELS_URL,
    {
      config,
      schema: { params: topicParams, body: levelOrderSchema, response: ok },
    },
    async (request) =>
      service.reorder(
        actorOf(request),
        request.params.topic,
        request.body.order,
      ),
  );
  typed.patch(
    `${LEVELS_URL}/:level`,
    {
      config,
      schema: { params: levelParams, body: levelRenameSchema, response: ok },
    },
    async (request) =>
      service.rename(actorOf(request), request.params, request.body),
  );
}

/** One document's level, up to the caller's own (KBC-103 FR-4, KBC-107 BR-2). */
function registerDocumentLevel(
  typed: Typed,
  documents: DocumentLevelsService,
): void {
  typed.put(
    '/api/v1/topics/:topic/documents/:id/level',
    {
      config: { access: CLASSIFY },
      schema: {
        params: documentParams,
        body: documentLevelUpdateSchema,
        response: { 200: documentLevelSchema },
      },
    },
    async (request) =>
      documents.setOne(classifierOf(request), {
        ...request.params,
        level: request.body.level,
      }),
  );
}

/** "Sem nível": the queue, the choices and the sidebar's counts (KBC-107 FR-1). */
function registerQueue(typed: Typed, documents: DocumentLevelsService): void {
  typed.get(
    `${LEVELS_URL}/unassigned`,
    {
      config: { access: CLASSIFY },
      schema: {
        params: topicParams,
        querystring: unassignedQuerySchema,
        response: { 200: unassignedPageSchema },
      },
    },
    async (request) =>
      documents.unassigned(
        viewerOf(request).person,
        request.params.topic,
        request.query,
      ),
  );
  typed.get(
    `${LEVELS_URL}/choices`,
    {
      config: { access: CLASSIFY },
      schema: { params: topicParams, response: { 200: levelChoicesSchema } },
    },
    async (request) =>
      documents.choices(viewerOf(request).person, request.params.topic),
  );
}

/** The sidebar's "N documentos sem nível", per collection (KBC-107 FR-6). */
function registerCounts(typed: Typed, documents: DocumentLevelsService): void {
  typed.get(
    '/api/v1/levels/unassigned',
    {
      config: { access: { feature: 'content-levels' } },
      schema: { response: { 200: unassignedCountsSchema } },
    },
    async (request) => documents.counts(viewerOf(request).person),
  );
}

/** A level for many documents at once (KBC-107 FR-2). */
function registerBulk(typed: Typed, documents: DocumentLevelsService): void {
  typed.post(
    '/api/v1/topics/:topic/document-levels',
    {
      config: { access: CLASSIFY },
      schema: {
        params: topicParams,
        body: bulkLevelRequestSchema,
        response: { 200: bulkLevelResultSchema },
      },
    },
    async (request) =>
      documents.bulk(classifierOf(request), request.params.topic, request.body),
  );
}

/** T24's routes (KBC-103 FR-1, FR-4; KBC-107 FR-1, FR-2). */
export const accessLevelRoutes =
  (services: {
    readonly service: AccessLevelsService;
    readonly documents: DocumentLevelsService;
  }): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    const { service, documents } = services;
    registerScales(typed, service);
    registerScale(typed, service);
    registerChanges(typed, service);
    registerDocumentLevel(typed, documents);
    registerQueue(typed, documents);
    registerCounts(typed, documents);
    registerBulk(typed, documents);
  };
