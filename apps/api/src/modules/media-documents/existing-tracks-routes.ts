import {
  publishExistingTracksRequestSchema,
  publishExistingTracksResultSchema,
  trackDocumentsOverviewSchema,
} from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { RouteAccess } from '../auth/index.js';
import type { ExistingTracks } from './existing-tracks.js';

/** Masters only, as "Publica no acervo" in Transcritores (KBC-099). */
const MASTER: RouteAccess = { master: true };

/** "Publicar no acervo as faixas que já existem": what is there to publish, and doing it. */
export const existingTracksRoutes =
  (tracks: ExistingTracks): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get(
      '/api/v1/media/track-documents',
      {
        config: { access: MASTER },
        schema: { response: { 200: trackDocumentsOverviewSchema } },
      },
      async () => tracks.overview(),
    );
    typed.post(
      '/api/v1/media/track-documents/publish',
      {
        config: { access: MASTER },
        schema: {
          body: publishExistingTracksRequestSchema,
          response: { 200: publishExistingTracksResultSchema },
        },
      },
      async (request) => tracks.publish(request.body.topics),
    );
  };
