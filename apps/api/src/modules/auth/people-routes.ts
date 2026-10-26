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
import { aiOf, applyAiUpdate } from './person-ai.js';
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
  /** Before saving: e.g. provision or drop the person's OpenRouter key; throws to refuse. */
  beforeChange(person: StoredPerson, next: PersonAi): Promise<void>;
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
      if (body.ai) await prepareAi(deps, { id: params.id, patch: body.ai, by });
      return view(deps, await deps.people.update(params.id, body, by));
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

/** Lets the house react before a person's AI limits are saved (provisioned keys). */
async function prepareAi(
  deps: PeopleRouteDeps,
  change: {
    id: string;
    patch: NonNullable<PersonUpdateBody['ai']>;
    by: string;
  },
): Promise<void> {
  const person = await deps.people.find(change.id);
  if (!person || !deps.ai) return;
  const next = applyAiUpdate(aiOf(person), change.patch, {
    by: change.by,
    now: new Date().toISOString(),
  });
  await deps.ai.beforeChange(person, next);
}

type PersonUpdateBody = z.infer<typeof personUpdateSchema>;

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
      if (setDefault && appAi === 'default')
        throw new AppError('VALIDATION_FAILED', 'Choose an AI for the default');
      if (setDefault && appAi !== 'default')
        await deps.ai?.setDefault(appAi, by);
      const updated = await deps.people.assignAi({ ids: personIds, appAi }, by);
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
