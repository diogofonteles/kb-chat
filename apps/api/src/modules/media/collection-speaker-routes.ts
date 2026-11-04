import {
  collectionSpeakerCreateSchema,
  collectionSpeakerListSchema,
  collectionSpeakerSchema,
  collectionSpeakerUpdateSchema,
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
import type { SpeakersService } from './speakers-service.js';

/** The list names people: it is for whoever edits that collection's recordings (BR-4). */
const EDIT: RouteAccess = { feature: 'media-edit', topicParam: 'topic' };
const params = z.object({ topic: topicSlugSchema });

const OPTIONS = {
  list: {
    config: { access: EDIT },
    schema: { params, response: { 200: collectionSpeakerListSchema } },
  },
  create: {
    config: { access: EDIT },
    schema: {
      params,
      body: collectionSpeakerCreateSchema,
      response: { 200: collectionSpeakerSchema, 201: collectionSpeakerSchema },
    },
  },
  update: {
    config: { access: EDIT },
    schema: {
      params: params.extend({ speakerId: z.uuid() }),
      body: collectionSpeakerUpdateSchema,
      response: { 200: collectionSpeakerSchema },
    },
  },
} as const;

type Typed = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface CollectionSpeakerRoutesDeps {
  readonly service: SpeakersService;
  readonly hasTopic: (topic: string) => boolean;
}

/** The slug of a collection that exists (a master "sees" any slug, even a wrong one). */
function knownTopic(deps: CollectionSpeakerRoutesDeps, topic: string): string {
  if (!deps.hasTopic(topic))
    throw new AppError('TOPIC_NOT_FOUND', `Unknown topic ${topic}`);
  return topic;
}

/** 201 for a new speaker, 200 when the name or author already is one. */
function registerCreate(typed: Typed, deps: CollectionSpeakerRoutesDeps): void {
  typed.post(
    '/api/v1/topics/:topic/speakers',
    OPTIONS.create,
    async (request, reply) => {
      const viewer = viewerOf(request);
      // While acting, the record names the master who did it (ADR 0027).
      const by = (viewer.actor?.viewer ?? viewer).person.email;
      const { speaker, created } = deps.service.add(
        knownTopic(deps, request.params.topic),
        request.body,
        by,
      );
      return reply.code(created ? 201 : 200).send(speaker);
    },
  );
}

/** The speakers of a collection (KBC-065 FR-1). */
export const collectionSpeakerRoutes =
  (deps: CollectionSpeakerRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get(
      '/api/v1/topics/:topic/speakers',
      OPTIONS.list,
      async (request) => ({
        items: deps.service.list(knownTopic(deps, request.params.topic)),
      }),
    );
    registerCreate(typed, deps);
    typed.patch(
      '/api/v1/topics/:topic/speakers/:speakerId',
      OPTIONS.update,
      async ({ params: { topic, speakerId }, body }) =>
        deps.service.update(knownTopic(deps, topic), speakerId, body),
    );
  };
