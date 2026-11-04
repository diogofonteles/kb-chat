import { mediaIdSchema, mediaWaveformSchema } from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteAccess } from '../auth/index.js';
import { actorOf } from './routes.js';
import type { WaveformService } from './waveform-service.js';

const LISTEN: RouteAccess = { feature: 'media' };

const OPTIONS = {
  waveform: {
    config: { access: LISTEN },
    schema: {
      params: z.object({ id: mediaIdSchema }),
      response: { 200: mediaWaveformSchema },
    },
  },
} as const;

/** A media item's peaks, for the waveform of the track validation (KBC-066). */
export const waveformRoutes =
  (service: WaveformService): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get('/api/v1/media/:id/waveform', OPTIONS.waveform, (request) =>
      service.forPerson(actorOf(request), request.params.id),
    );
  };
