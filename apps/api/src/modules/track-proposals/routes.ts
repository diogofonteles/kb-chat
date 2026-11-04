import {
  draftTracksSchema,
  mediaIdSchema,
  proposalEstimateSchema,
  proposalRequestSchema,
  proposalRunSchema,
} from '@kb-chat/contracts';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  assertFeature,
  canSee,
  hasFeature,
  isMaster,
  viewerOf,
  type RouteAccess,
} from '../auth/index.js';
import type { MediaActor } from '../media/index.js';
import type { ProposalService } from './proposal-service.js';

/**
 * Proposing with AI needs its own feature on top of editing (KBC-067 BR-2, ADR 0029 §9), and
 * `media`, as every media route.
 */
const PROPOSE: RouteAccess = { feature: 'media-edit-ai' };
const EDIT: RouteAccess = { feature: 'media-edit' };
/** Runs a person may start per minute: each spends money (ND-22); the month caps the rest. */
const PROPOSALS_PER_MINUTE = 6;
const mediaParams = z.object({ id: mediaIdSchema });
const runParams = z.object({ id: mediaIdSchema, runId: z.uuid() });

function actorOf(request: FastifyRequest): MediaActor {
  const viewer = viewerOf(request);
  return {
    principal: viewer.principal,
    isMaster: isMaster(viewer.person),
    canUpload: hasFeature(viewer.person, 'media-upload'),
    canSee: (topic) => canSee(request, topic),
  };
}

/** Both features: the route checks one, the handler the other (BR-2). */
function proposer(request: FastifyRequest): MediaActor {
  assertFeature(request, 'media-edit');
  return actorOf(request);
}

const needsMedia = async (request: FastifyRequest): Promise<void> => {
  assertFeature(request, 'media');
};

const OPTIONS = {
  propose: {
    config: {
      access: PROPOSE,
      rateLimit: { max: PROPOSALS_PER_MINUTE, timeWindow: '1 minute' },
    },
    schema: {
      params: mediaParams,
      body: proposalRequestSchema,
      response: { 200: proposalEstimateSchema, 202: proposalRunSchema },
    },
  },
  run: {
    config: { access: PROPOSE },
    schema: { params: runParams, response: { 200: proposalRunSchema } },
  },
  draft: {
    config: { access: EDIT },
    schema: { params: mediaParams, response: { 200: draftTracksSchema } },
  },
} as const;

/** The AI's track proposals (KBC-067 FR-1): estimate, start, follow and the draft. */
export const trackProposalRoutes =
  (service: ProposalService): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', needsMedia);
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.post(
      '/api/v1/media/:id/edit/proposals',
      OPTIONS.propose,
      async (request, reply) => {
        const actor = proposer(request);
        const { id } = request.params;
        if (request.body.dryRun) return service.estimate(actor, id);
        return reply.code(202).send(await service.start(actor, id));
      },
    );
    typed.get(
      '/api/v1/media/:id/edit/proposals/:runId',
      OPTIONS.run,
      async (request) =>
        service.getRun(
          proposer(request),
          request.params.id,
          request.params.runId,
        ),
    );
    typed.get(
      '/api/v1/media/:id/edit/draft-tracks',
      OPTIONS.draft,
      async (request) => service.draft(actorOf(request), request.params.id),
    );
  };
