import {
  mediaIdSchema,
  topicSlugSchema,
  uploadCheckRequestSchema,
  uploadCheckSchema,
} from '@kb-chat/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { RouteAccess } from '../auth/index.js';
import type { MediaActor, MediaService } from './media-service.js';

/** The tus 1.0 version this API speaks (KBC-035, ADR 0033). */
const TUS_VERSION = '1.0.0';
const PART_TYPE = 'application/offset+octet-stream';

const UPLOAD: RouteAccess = { feature: 'media-upload' };
const options = {
  config: { access: UPLOAD },
  schema: {
    params: z.object({ id: mediaIdSchema }),
    response: { 204: z.undefined() },
  },
};

const checkOptions = {
  config: { access: { ...UPLOAD, topicParam: 'topic' } },
  schema: {
    params: z.object({ topic: topicSlugSchema }),
    body: uploadCheckRequestSchema,
    response: { 200: uploadCheckSchema },
  },
};

/** Upload-Offset as tus sends it: digits only. */
const offsetSchema = z
  .string()
  .regex(/^\d{1,13}$/)
  .transform(Number);

function offsetOf(request: FastifyRequest): number {
  const offset = offsetSchema.safeParse(request.headers['upload-offset']);
  if (!offset.success)
    throw new AppError('VALIDATION_FAILED', 'Upload-Offset is required', {
      details: { field: 'offset' },
    });
  return offset.data;
}

function partOf(request: FastifyRequest): Readable {
  if (request.body instanceof Readable) return request.body;
  throw new AppError('UNSUPPORTED_MEDIA_TYPE', `Send a part as ${PART_TYPE}`);
}

const tusReply = (reply: FastifyReply, offset: number) =>
  reply
    .code(204)
    .header('tus-resumable', TUS_VERSION)
    .header('upload-offset', offset)
    .header('cache-control', 'no-store');

/**
 * The core of tus 1.0 on an item that already exists (KBC-035, ADR 0033): HEAD says how much
 * arrived and PATCH appends. There is no creation here: `POST …/media` is that step, and
 * every check of the session, the CSRF header and the owner stays on these routes.
 */
export function registerUploadRoutes(
  app: FastifyInstance,
  service: MediaService,
  actorOf: (request: FastifyRequest) => MediaActor,
): void {
  // Parts are streamed to disk as they arrive, never buffered.
  app.addContentTypeParser(PART_TYPE, (_request, payload, done) =>
    done(null, payload),
  );
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/topics/:topic/media/check',
    checkOptions,
    async (request) =>
      service.check(actorOf(request), request.params.topic, request.body),
  );
  typed.head('/api/v1/media/:id/upload', options, async (request, reply) => {
    const { id } = request.params;
    const status = await service.uploadStatus(actorOf(request), id);
    return tusReply(reply, status.offset)
      .header('upload-length', status.length)
      .send();
  });
  typed.patch('/api/v1/media/:id/upload', options, async (request, reply) => {
    const offset = await service.receivePart(
      actorOf(request),
      request.params.id,
      { body: partOf(request), offset: offsetOf(request) },
    );
    return tusReply(reply, offset).send();
  });
}
