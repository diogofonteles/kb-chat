import {
  aiAssignmentRequestSchema,
  aiAssignmentResultSchema,
  type AppAi,
  type PersonAi,
  inviteRequestSchema,
  personIdSchema,
  personListSchema,
  personSchema,
  personUpdateSchema,
} from '@kb-chat/contracts';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import { viewerOf, type RouteAccess } from './access.js';
import type { Invitations } from './invitations.js';
import type { PeopleService } from './people-service.js';
import { aiOf } from './person-ai.js';
import { toPerson, type StoredPerson } from './person.js';
import type { SessionService } from './session-service.js';

export interface PeopleRouteDeps {
  readonly people: PeopleService;
  readonly sessions: SessionService;
  /** Every collection slug in the vault: a grant must name one. */
  readonly topics: () => readonly string[];
  /** The invitation e-mail sent on invite (KBC-026). */
  readonly invitations: Invitations;
  /** What the house AI does around a person's AI change (KBC-022); none in tests. */
  readonly ai?: PeopleAiHooks;
}

/** The house side of the AI access policy, called by the people routes (KBC-022). */
export interface PeopleAiHooks {
  /** After a person's AI was saved: e.g. provision or drop their OpenRouter key; throws on failure. */
  sync(person: StoredPerson, ai: PersonAi): Promise<void>;
  /** "Também para os próximos": the default for people left on `default`. */
  setDefault(appAi: AppAi, by: string): Promise<void>;
}

const MASTER: RouteAccess = { master: true };
const params = z.object({ id: personIdSchema });

const view = (deps: PeopleRouteDeps, person: StoredPerson) =>
  toPerson(person, deps.people.isOwner(person));

function assertKnownTopics(deps: PeopleRouteDeps, topics?: readonly string[]) {
  const known = new Set(deps.topics());
  const unknown = (topics ?? []).filter((topic) => !known.has(topic));
  if (unknown.length > 0)
    throw new AppError('VALIDATION_FAILED', 'Unknown collection', {
      details: { topics: unknown },
    });
}

function registerReads(app: FastifyInstance, deps: PeopleRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/v1/people',
    {
      config: { access: MASTER },
      schema: { response: { 200: personListSchema } },
    },
    async () => ({
      items: (await deps.people.list()).map((person) => view(deps, person)),
    }),
  );
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/people',
    {
      config: { access: MASTER },
      schema: { body: inviteRequestSchema, response: { 201: personSchema } },
    },
    async (request, reply) => {
      const inviter = viewerOf(request).person;
      const { email, sendEmail } = request.body;
      const invited = await deps.people.invite(email, inviter.email);
      const result = sendEmail
        ? await deps.invitations.afterInvite(invited, inviter, request.log)
        : invited;
      return reply.code(201).send(view(deps, result));
    },
  );
}

function registerPatch(app: FastifyInstance, deps: PeopleRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().patch(
    '/api/v1/people/:id',
    {
      config: { access: MASTER },
      schema: {
        params,
        body: personUpdateSchema,
        response: { 200: personSchema },
      },
    },
    async (request) => {
      const { params, body } = request;
      assertKnownTopics(deps, body.topics);
      const by = viewerOf(request).person.email;
      const before = await deps.people.find(params.id);
      const updated = await deps.people.update(params.id, body, by);
      if (body.ai && before) await syncAi(deps, { before, updated, by });
      return view(deps, updated);
    },
  );
}

function registerWrites(app: FastifyInstance, deps: PeopleRouteDeps) {
  registerPatch(app, deps);
  app.withTypeProvider<ZodTypeProvider>().delete(
    '/api/v1/people/:id',
    {
      config: { access: MASTER },
      schema: { params, response: { 204: z.undefined() } },
    },
    async ({ params: { id } }, reply) => {
      await deps.people.revoke(id);
      // BR-4: the revoked person's open sessions end now.
      await deps.sessions.destroyFor(id);
      return reply.code(204).send();
    },
  );
}

/**
 * Lets the house follow a saved AI change (provisioned keys). When that fails, the paid
 * fallback goes back to what it was, so no person is left half changed (review fix).
 */
async function syncAi(
  deps: PeopleRouteDeps,
  change: { before: StoredPerson; updated: StoredPerson; by: string },
): Promise<void> {
  if (!deps.ai) return;
  try {
    await deps.ai.sync(change.updated, aiOf(change.updated));
  } catch (err) {
    const paidFallback = aiOf(change.before).paidFallback;
    await deps.people.update(
      change.updated.id,
      { ai: { paidFallback } },
      change.by,
    );
    throw err;
  }
}

/** One app AI for several people or everyone, optionally the default too (KBC-022 AC-12). */
function registerAssignment(app: FastifyInstance, deps: PeopleRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/people/ai-assignment',
    {
      config: { access: MASTER },
      schema: {
        body: aiAssignmentRequestSchema,
        response: { 200: aiAssignmentResultSchema },
      },
    },
    async (request) => {
      const { personIds, appAi, setDefault } = request.body;
      const by = viewerOf(request).person.email;
      const updated = await deps.people.assignAi({ ids: personIds, appAi }, by);
      // The contract allows setDefault only with "all" and an AI (not "default").
      if (setDefault && appAi !== 'default')
        await deps.ai?.setDefault(appAi, by);
      return { updated };
    },
  );
}

/** "Pessoas e permissões" (FR-3): masters only. */
export const peopleRoutes =
  (deps: PeopleRouteDeps): FastifyPluginAsync =>
  async (app) => {
    registerReads(app, deps);
    registerWrites(app, deps);
    registerAssignment(app, deps);
  };
