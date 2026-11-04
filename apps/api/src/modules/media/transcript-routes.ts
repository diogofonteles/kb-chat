import {
  mediaIdSchema,
  mediaTranscriptSchema,
  mediaTranscriptWordsSchema,
  transcriptWordsQuerySchema,
} from '@kb-chat/contracts';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { hasFeature, viewerOf, type RouteAccess } from '../auth/index.js';
import { actorOf } from './routes.js';
import type { TranscriptService } from './transcript-service.js';

/** Reading along is part of listening: the `media` feature, as the stream (FR-1). */
const LISTEN: RouteAccess = { feature: 'media' };
const mediaParams = z.object({ id: mediaIdSchema });
type SubtitlesRequest = FastifyRequest<{ Params: z.infer<typeof mediaParams> }>;

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
  words: {
    config: { access: LISTEN },
    schema: {
      params: mediaParams,
      querystring: transcriptWordsQuerySchema,
      response: { 200: mediaTranscriptWordsSchema },
    },
  },
  subtitles: { config: { access: LISTEN }, schema: { params: mediaParams } },
} as const;

/** Private (per-person access) and revalidated: a new version shows at once. */
function serveSubtitles(
  service: TranscriptService,
  { request, reply }: { request: SubtitlesRequest; reply: FastifyReply },
): FastifyReply {
  const { etag, body } = service.subtitles(actorOf(request), request.params.id);
  reply.header('cache-control', 'private, no-cache').header('etag', etag);
  if (matches(request.headers['if-none-match'], etag))
    return reply.code(304).send();
  return reply.type('text/vtt; charset=utf-8').send(body);
}

/** The current transcript, its words by page (KBC-045) and its WebVTT subtitles (KBC-038). */
export const transcriptRoutes =
  (service: TranscriptService): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get('/api/v1/media/:id/transcript', OPTIONS.transcript, (request) =>
      Promise.resolve(
        service.current(actorOf(request), request.params.id, {
          withTermList: actorOf(request).isMaster,
          // The voices are for whoever edits recordings (KBC-064 FR-4), who sees the names
          // anyway; the names, for whoever may see who speaks (KBC-065 BR-4).
          withVoices: hasFeature(viewerOf(request).person, 'media-edit'),
          withNames: hasFeature(viewerOf(request).person, 'media-speakers'),
        }),
      ),
    );
    typed.get('/api/v1/media/:id/transcript/words', OPTIONS.words, (request) =>
      Promise.resolve(
        service.words(actorOf(request), request.params.id, request.query),
      ),
    );
    typed.get(
      '/api/v1/media/:id/subtitles.vtt',
      OPTIONS.subtitles,
      (request, reply) => serveSubtitles(service, { request, reply }),
    );
  };
