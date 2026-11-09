import {
  documentSchema,
  relationPageSchema,
  seeAlsoGroupNameSchema,
  topicSlugSchema,
} from '@kb-chat/contracts';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { TrackShelf } from '../../ports/track-shelf.js';
import { hasFeature, viewerOf, type RouteAccess } from '../auth/index.js';
import type { DocumentReader, DocumentsService } from './documents-service.js';

/** What "Veja também" needs to show tracks (absent with media off: texts only). */
export interface DocumentRouteOptions {
  readonly tracks?: () => TrackShelf;
}

/** Who may research tracks (KBC-099 BR-4) sees the linked ones (KBC-101 BR-5). */
const RESEARCHES_TRACKS = [
  'research',
  'media',
  'media-tracks',
  'media-research',
] as const;

function readerOf(
  request: FastifyRequest,
  tracks: DocumentRouteOptions['tracks'],
): DocumentReader {
  const { person } = viewerOf(request);
  if (!tracks || !RESEARCHES_TRACKS.every((one) => hasFeature(person, one)))
    return {};
  const shelf = tracks();
  return { seesTrack: (topic, media) => shelf.trackOf(topic, media) !== null };
}

/** Reading needs only the collection: research answers cite documents too (KBC-010). */
const READ_ACCESS: RouteAccess = { topicParam: 'topic' };

const documentParams = z.object({
  topic: topicSlugSchema,
  id: z.string().min(1).max(1024),
});

const relationsQuery = z.object({
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

function registerDocument(
  app: FastifyInstance,
  { service, tracks }: { service: DocumentsService } & DocumentRouteOptions,
): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/v1/topics/:topic/documents/:id',
    {
      config: { access: READ_ACCESS },
      schema: { params: documentParams, response: { 200: documentSchema } },
    },
    async (request) =>
      service.getDocument(
        request.params.topic,
        request.params.id,
        readerOf(request, tracks),
      ),
  );
}

function registerRelations(
  app: FastifyInstance,
  { service, tracks }: { service: DocumentsService } & DocumentRouteOptions,
): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/v1/topics/:topic/documents/:id/relations/:group',
    {
      config: { access: READ_ACCESS },
      schema: {
        params: documentParams.extend({ group: seeAlsoGroupNameSchema }),
        querystring: relationsQuery,
        response: { 200: relationPageSchema },
      },
    },
    async (request) => {
      const { topic, id, group } = request.params;
      return service.relationPage(topic, id, {
        query: { group, ...request.query },
        reader: readerOf(request, tracks),
      });
    },
  );
}

export const documentRoutes =
  (
    service: DocumentsService,
    { tracks }: DocumentRouteOptions = {},
  ): FastifyPluginAsync =>
  async (app) => {
    registerDocument(app, { service, tracks });
    registerRelations(app, { service, tracks });
  };
