import { mediaIdSchema, mediaPublicationSchema } from '@kb-chat/contracts';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteAccess } from '../auth/index.js';
import { actorOf, type MediaActor } from '../media/index.js';
import type { PublicationStatus } from './publication-status.js';

/** Who edits a track sees where it stands in the research (T22, KBC-100 FR-3). */
const EDIT: RouteAccess = { feature: 'media-edit' };
/** The publishing queue in Transcritores is for masters (KBC-099). */
const MASTER: RouteAccess = { master: true };
const params = z.object({ id: mediaIdSchema });

export interface PublicationRoutesDeps {
  readonly status: PublicationStatus;
  /** The media as this person sees it; throws MEDIA_NOT_FOUND when they cannot. */
  readonly findMedia: (actor: MediaActor, mediaId: string) => unknown;
}

/** The state of a media, for who edits it in a collection they see. */
function registerState(
  app: FastifyInstance,
  { status, findMedia }: PublicationRoutesDeps,
): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/v1/media/:id/publication',
    {
      config: { access: EDIT },
      schema: { params, response: { 200: mediaPublicationSchema } },
    },
    async (request) => {
      const mediaId = request.params.id;
      findMedia(actorOf(request), mediaId);
      return { mediaId, publication: status.of(mediaId) };
    },
  );
}

/** **Tentar de novo** on a media's page. */
function registerRetry(
  app: FastifyInstance,
  { status, findMedia }: PublicationRoutesDeps,
): void {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/media/:id/publication/retry',
    {
      config: { access: EDIT },
      schema: { params, response: { 202: mediaPublicationSchema } },
    },
    async (request, reply) => {
      const mediaId = request.params.id;
      findMedia(actorOf(request), mediaId);
      return reply
        .code(202)
        .send({ mediaId, publication: status.retry(mediaId) });
    },
  );
}

/** From the queue's "Falhou" list: also a removal whose media was deleted since (review 5). */
function registerQueueRetry(
  app: FastifyInstance,
  { status }: PublicationRoutesDeps,
): void {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/media/track-documents/failed/:id/retry',
    {
      config: { access: MASTER },
      schema: { params, response: { 202: mediaPublicationSchema } },
    },
    async (request, reply) => {
      const mediaId = request.params.id;
      return reply
        .code(202)
        .send({ mediaId, publication: status.retry(mediaId) });
    },
  );
}

/** A media's publication state and **Tentar de novo**. */
export const publicationRoutes =
  (deps: PublicationRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    registerState(app, deps);
    registerRetry(app, deps);
    registerQueueRetry(app, deps);
  };
