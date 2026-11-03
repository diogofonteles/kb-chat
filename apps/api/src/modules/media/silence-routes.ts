import { mediaIdSchema, mediaSilencesSchema } from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteAccess } from '../auth/index.js';
import { actorOf } from './routes.js';
import type { SilenceService } from './silence-service.js';

/** Part of listening: the `media` feature, as the stream (KBC-044 FR-3, owner's rule). */
const LISTEN: RouteAccess = { feature: 'media' };

const OPTIONS = {
  silences: {
    config: { access: LISTEN },
    schema: {
      params: z.object({ id: mediaIdSchema }),
      response: { 200: mediaSilencesSchema },
    },
  },
} as const;

/** A media item's silence map, for the player's "Encurtar silêncios" (KBC-044). */
export const silenceRoutes =
  (service: SilenceService): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get('/api/v1/media/:id/silences', OPTIONS.silences, (request) =>
      service.forPerson(actorOf(request), request.params.id),
    );
  };
