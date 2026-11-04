import {
  MAX_VOICE_PROFILE_BODY_BYTES,
  createVoiceProfileRequestSchema,
  namedVoiceListSchema,
  topicSlugSchema,
  voiceProfileListSchema,
  voiceProfileReportSchema,
  voiceProfileSchema,
} from '@kb-chat/contracts';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import { viewerOf, type RouteAccess } from '../auth/index.js';
import { actorOf } from './routes.js';
import type {
  VoiceProfileActor,
  VoiceProfileService,
} from './voice-profile-service.js';

/**
 * Biometric data: the master role and a grant to that master by name (ADR 0032), never while
 * acting as someone: a consent names who registered it. `media` too: profiles are made from
 * recordings.
 */
const ACCESS: RouteAccess = {
  feature: ['media', 'media-voice-profiles'],
  master: true,
  notWhileActing: true,
};
const IN_COLLECTION: RouteAccess = { ...ACCESS, topicParam: 'topic' };
const topicParams = z.object({ topic: topicSlugSchema });
const profileParams = z.object({ id: z.uuid() });

const OPTIONS = {
  list: {
    config: { access: IN_COLLECTION },
    schema: {
      params: topicParams,
      response: { 200: voiceProfileListSchema },
    },
  },
  create: {
    config: { access: IN_COLLECTION },
    bodyLimit: MAX_VOICE_PROFILE_BODY_BYTES,
    schema: {
      params: topicParams,
      body: createVoiceProfileRequestSchema,
      response: { 201: voiceProfileSchema },
    },
  },
  namedVoices: {
    config: { access: IN_COLLECTION },
    schema: {
      params: topicParams.extend({ speakerId: z.uuid() }),
      response: { 200: namedVoiceListSchema },
    },
  },
  revoke: {
    config: { access: ACCESS },
    schema: { params: profileParams, response: { 204: z.undefined() } },
  },
  recalculate: {
    config: { access: ACCESS },
    schema: { params: profileParams, response: { 200: voiceProfileSchema } },
  },
  report: {
    config: { access: ACCESS },
    schema: { response: { 200: voiceProfileReportSchema } },
  },
  evidence: {
    config: { access: ACCESS },
    schema: { params: profileParams },
  },
} as const;

const actorFrom = (request: FastifyRequest): VoiceProfileActor => ({
  email: viewerOf(request).person.email,
  canSee: actorOf(request).canSee,
});

/** "Perfis e consentimentos" is the owner's (AC-8). */
function assertOwner(request: FastifyRequest): void {
  if (!viewerOf(request).isOwner)
    throw new AppError('FORBIDDEN', 'Only the owner reads this report');
}

function registerReport(
  app: FastifyInstance,
  service: VoiceProfileService,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    '/api/v1/voice-profiles/report',
    OPTIONS.report,
    async (request, reply) => {
      assertOwner(request);
      return reply
        .header('cache-control', 'no-store')
        .send({ items: service.report() });
    },
  );
}

function registerEvidence(
  app: FastifyInstance,
  service: VoiceProfileService,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    '/api/v1/voice-consents/:id/evidence',
    OPTIONS.evidence,
    async (request, reply) => {
      assertOwner(request);
      const { id } = request.params;
      const { mime, data, extension } = service.evidence(id);
      return reply
        .header('content-type', mime)
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .header(
          'content-disposition',
          `attachment; filename="consentimento-${id}.${extension}"`,
        )
        .send(data);
    },
  );
}

function registerRevocation(
  app: FastifyInstance,
  service: VoiceProfileService,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.delete(
    '/api/v1/voice-profiles/:id',
    OPTIONS.revoke,
    async (request, reply) => {
      await service.revoke(actorFrom(request), request.params.id);
      return reply.code(204).send();
    },
  );
  typed.post(
    '/api/v1/voice-profiles/:id/recalculate',
    OPTIONS.recalculate,
    (request) => service.recalculate(actorFrom(request), request.params.id),
  );
}

/** "Perfis de voz" (KBC-071 FR-1, FR-4, FR-5). */
export const voiceProfileRoutes =
  (service: VoiceProfileService): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get('/api/v1/topics/:topic/voice-profiles', OPTIONS.list, (request) =>
      service.list(request.params.topic),
    );
    typed.post(
      '/api/v1/topics/:topic/voice-profiles',
      OPTIONS.create,
      async (request, reply) => {
        const created = await service.create(
          { topic: request.params.topic, by: actorFrom(request).email },
          request.body,
        );
        return reply.code(201).send(created);
      },
    );
    typed.get(
      '/api/v1/topics/:topic/speakers/:speakerId/named-voices',
      OPTIONS.namedVoices,
      async ({ params: { topic, speakerId } }) => ({
        items: service.namedVoices(topic, speakerId),
      }),
    );
    registerRevocation(app, service);
    registerReport(app, service);
    registerEvidence(app, service);
  };
