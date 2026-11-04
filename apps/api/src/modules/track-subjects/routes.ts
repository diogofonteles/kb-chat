import {
  collectionSubjectsSchema,
  createSubjectRequestSchema,
  decideSuggestionsRequestSchema,
  editSubjectsSchema,
  freeSubjectSchema,
  mediaIdSchema,
  saveTrackSubjectsRequestSchema,
  subjectEstimateSchema,
  trackSuggestionRequestSchema,
  trackSuggestionSchema,
  subjectProposalRequestSchema,
  subjectRunSchema,
  topicSlugSchema,
  trackAboutSchema,
  trackSubjectsSchema,
} from '@kb-chat/contracts';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import {
  assertFeature,
  hasFeature,
  viewerOf,
  type RouteAccess,
} from '../auth/index.js';
import { actorOf } from '../media/index.js';
import type { SubjectProposalService } from './subject-proposal-service.js';
import type { TrackSuggestionService } from './track-suggestion-service.js';
import type {
  SubjectCall,
  TrackSubjectService,
} from './track-subject-service.js';

/** Classifying is its own feature (ADR 0029 §9), on top of `media` as every media route. */
const CLASSIFY: RouteAccess = { feature: 'media-classify' };
const COLLECTION: RouteAccess = {
  feature: 'media-classify',
  topicParam: 'topic',
};
/** What a listener reads of a track: its feature, with tracks in sight (KBC-070). */
const ABOUT: RouteAccess = {
  feature: ['media', 'media-tracks', 'media-subjects'],
};
/** The route checks the AI's feature, the handler `media-classify` (AC-6). */
const SUGGEST: RouteAccess = { feature: 'media-edit-ai' };
/** Each run spends money (ND-22); the month caps the rest. */
const RUNS_PER_MINUTE = 6;
const ETAG = /^"(\d+)"$/;
const mediaParams = z.object({ id: mediaIdSchema });
const topicParams = z.object({ topic: topicSlugSchema });

type Typed = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface SubjectRoutesDeps {
  readonly subjects: TrackSubjectService;
  readonly proposals: SubjectProposalService;
  readonly suggestions: TrackSuggestionService;
  readonly hasTopic: (topic: string) => boolean;
}

function callOf(request: FastifyRequest, mediaId: string): SubjectCall {
  const match = ETAG.exec(request.headers['if-match'] ?? '');
  if (!match?.[1])
    throw new AppError('EDIT_VERSION_REQUIRED', 'If-Match is required');
  return {
    actor: actorOf(request),
    mediaId,
    expectedVersion: Number(match[1]),
  };
}

const knownTopic = (deps: SubjectRoutesDeps, topic: string): string => {
  if (!deps.hasTopic(topic))
    throw new AppError('TOPIC_NOT_FOUND', `Unknown topic ${topic}`);
  return topic;
};

const COLLECTION_ROUTE = {
  config: { access: COLLECTION },
  schema: { params: topicParams },
};

function registerCollection(typed: Typed, deps: SubjectRoutesDeps): void {
  const { subjects } = deps;
  const url = '/api/v1/topics/:topic/subjects';
  const read = {
    ...COLLECTION_ROUTE,
    schema: {
      ...COLLECTION_ROUTE.schema,
      response: { 200: collectionSubjectsSchema },
    },
  };
  const create = {
    ...COLLECTION_ROUTE,
    schema: {
      ...COLLECTION_ROUTE.schema,
      body: createSubjectRequestSchema,
      response: { 201: freeSubjectSchema },
    },
  };
  typed.get(url, read, async (request) =>
    subjects.collection(knownTopic(deps, request.params.topic)),
  );
  typed.post(url, create, async (request, reply) => {
    const topic = knownTopic(deps, request.params.topic);
    const { name } = request.body;
    return reply
      .code(201)
      .send(subjects.createFree(actorOf(request), topic, name));
  });
}

function registerAbout(typed: Typed, { subjects }: SubjectRoutesDeps): void {
  typed.get(
    '/api/v1/media/:id/about',
    {
      config: { access: ABOUT },
      schema: { params: mediaParams, response: { 200: trackAboutSchema } },
    },
    async (request) => subjects.about(actorOf(request), request.params.id),
  );
}

function registerTrack(typed: Typed, deps: SubjectRoutesDeps): void {
  const { subjects } = deps;
  const read = {
    config: { access: CLASSIFY },
    schema: { params: mediaParams, response: { 200: trackSubjectsSchema } },
  };
  typed.get('/api/v1/media/:id/subjects', read, async (request) =>
    subjects.read(actorOf(request), request.params.id),
  );
  typed.put(
    '/api/v1/media/:id/subjects',
    {
      ...read,
      schema: { ...read.schema, body: saveTrackSubjectsRequestSchema },
    },
    async (request) =>
      subjects.save(callOf(request, request.params.id), request.body),
  );
  typed.post(
    '/api/v1/media/:id/subjects/decisions',
    {
      ...read,
      schema: { ...read.schema, body: decideSuggestionsRequestSchema },
    },
    async (request) =>
      subjects.decide(callOf(request, request.params.id), request.body),
  );
}

const STEP_ROUTE = {
  config: { access: CLASSIFY },
  schema: { params: mediaParams, response: { 200: editSubjectsSchema } },
};

const PROPOSE_ROUTE = {
  config: {
    access: SUGGEST,
    rateLimit: { max: RUNS_PER_MINUTE, timeWindow: '1 minute' },
  },
  schema: {
    params: mediaParams,
    body: subjectProposalRequestSchema,
    response: { 200: subjectEstimateSchema, 202: subjectRunSchema },
  },
};

const SUGGESTION_ROUTE = {
  config: {
    access: SUGGEST,
    rateLimit: { max: RUNS_PER_MINUTE, timeWindow: '1 minute' },
  },
  schema: {
    params: mediaParams,
    body: trackSuggestionRequestSchema,
    response: { 200: subjectEstimateSchema, 201: trackSuggestionSchema },
  },
};

/** "Sugerir de novo com IA" (KBC-073 FR-7): subjects only for who classifies. */
function registerSuggestions(typed: Typed, deps: SubjectRoutesDeps): void {
  typed.post(
    '/api/v1/media/:id/suggestions',
    SUGGESTION_ROUTE,
    async (request, reply) => {
      assertFeature(request, 'media-edit');
      const call = {
        actor: actorOf(request),
        mediaId: request.params.id,
        classify: hasFeature(viewerOf(request).person, 'media-classify'),
      };
      if (request.body.dryRun) return deps.suggestions.estimate(call);
      return reply.code(201).send(await deps.suggestions.suggest(call));
    },
  );
}

function registerEdit(typed: Typed, deps: SubjectRoutesDeps): void {
  const { proposals } = deps;
  typed.get('/api/v1/media/:id/edit/subjects', STEP_ROUTE, async (request) =>
    proposals.edit(actorOf(request), request.params.id),
  );
  typed.post(
    '/api/v1/media/:id/edit/subject-proposals',
    PROPOSE_ROUTE,
    async (request, reply) => {
      assertFeature(request, 'media-classify');
      const actor = actorOf(request);
      const { id } = request.params;
      if (request.body.dryRun) return proposals.estimate(actor, id);
      return reply.code(202).send(await proposals.start(actor, id));
    },
  );
}

/** A track's subjects and the collection's (KBC-069 FR-1 to FR-3). */
export const trackSubjectRoutes =
  (deps: SubjectRoutesDeps): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', async (request) => {
      assertFeature(request, 'media');
    });
    const typed = app.withTypeProvider<ZodTypeProvider>();
    registerCollection(typed, deps);
    registerAbout(typed, deps);
    registerTrack(typed, deps);
    registerEdit(typed, deps);
    registerSuggestions(typed, deps);
  };
