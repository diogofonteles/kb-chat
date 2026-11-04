import {
  collectionSpeakerCreateSchema,
  collectionSpeakerListSchema,
  collectionSpeakerSchema,
  collectionSpeakerUpdateSchema,
  topicSlugSchema,
} from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
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

export interface CollectionSpeakerRoutesDeps {
  readonly service: SpeakersService;
  readonly hasTopic: (topic: string) => boolean;
}

/** The speakers of a collection (KBC-065 FR-1). */
export const collectionSpeakerRoutes =
  ({ service, hasTopic }: CollectionSpeakerRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    /** The slug of a collection that exists (a master "sees" any slug, even a wrong one). */
    const known = (topic: string): string => {
      if (!hasTopic(topic))
        throw new AppError('TOPIC_NOT_FOUND', `Unknown topic ${topic}`);
      return topic;
    };
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get(
      '/api/v1/topics/:topic/speakers',
      OPTIONS.list,
      async (request) => ({
        items: service.list(known(request.params.topic)),
      }),
    );
    typed.post(
      '/api/v1/topics/:topic/speakers',
      OPTIONS.create,
      async (request, reply) => {
        const viewer = viewerOf(request);
        // While acting, the record names the master who did it (ADR 0027).
        const by = (viewer.actor?.viewer ?? viewer).person.email;
        const { speaker, created } = service.add(
          known(request.params.topic),
          request.body,
          by,
        );
        return reply.code(created ? 201 : 200).send(speaker);
      },
    );
    typed.patch(
      '/api/v1/topics/:topic/speakers/:speakerId',
      OPTIONS.update,
      async ({ params: { topic, speakerId }, body }) =>
        service.update(known(topic), speakerId, body),
    );
  };
