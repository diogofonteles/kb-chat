import { mediaIdSchema, mediaTranscriptSchema } from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteAccess } from '../auth/index.js';
import { actorOf } from './routes.js';
import type { TranscriptService } from './transcript-service.js';

/** Reading along is part of listening: the `media` feature, as the stream (FR-1). */
const LISTEN: RouteAccess = { feature: 'media' };
const mediaParams = z.object({ id: mediaIdSchema });

/** The caller already has this version when one of its tags matches (RFC 9110 §13.1.2). */
function matches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === etag || tag === '*');
}

const OPTIONS = {
  transcript: {
    config: { access: LISTEN },
    schema: { params: mediaParams, response: { 200: mediaTranscriptSchema } },
  },
  subtitles: { config: { access: LISTEN }, schema: { params: mediaParams } },
} as const;

/** The current transcript and its WebVTT subtitles (KBC-038 FR-1, FR-2). */
export const transcriptRoutes =
  (service: TranscriptService): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get('/api/v1/media/:id/transcript', OPTIONS.transcript, (request) =>
      Promise.resolve(service.current(actorOf(request), request.params.id)),
    );
    typed.get(
      '/api/v1/media/:id/subtitles.vtt',
      OPTIONS.subtitles,
      async (request, reply) => {
        const { etag, body } = service.subtitles(
          actorOf(request),
          request.params.id,
        );
        // Private (per-person access) and revalidated: a new version shows at once.
        reply.header('cache-control', 'private, no-cache').header('etag', etag);
        if (matches(request.headers['if-none-match'], etag))
          return reply.code(304).send();
        return reply.type('text/vtt; charset=utf-8').send(body);
      },
    );
  };
