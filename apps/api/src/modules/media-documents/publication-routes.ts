import { mediaIdSchema, mediaPublicationSchema } from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteAccess } from '../auth/index.js';
import { actorOf, type MediaActor } from '../media/index.js';
import type { PublicationStatus } from './publication-status.js';

/** Who edits a track sees where it stands in the research (T22, KBC-100 FR-3). */
const EDIT: RouteAccess = { feature: 'media-edit' };
const params = z.object({ id: mediaIdSchema });

export interface PublicationRoutesDeps {
  readonly status: PublicationStatus;
  /** The media as this person sees it; throws MEDIA_NOT_FOUND when they cannot. */
  readonly findMedia: (actor: MediaActor, mediaId: string) => unknown;
}

/** A media's publication state and **Tentar de novo**. */
export const publicationRoutes =
  ({ status, findMedia }: PublicationRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get(
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
    typed.post(
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
  };
