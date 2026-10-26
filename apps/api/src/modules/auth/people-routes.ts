import {
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
import { toPerson, type StoredPerson } from './person.js';
import type { SessionService } from './session-service.js';

export interface PeopleRouteDeps {
  readonly people: PeopleService;
  readonly sessions: SessionService;
  /** Every collection slug in the vault: a grant must name one. */
  readonly topics: () => readonly string[];
  /** The invitation e-mail sent on invite (KBC-026). */
  readonly invitations: Invitations;
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

function registerWrites(app: FastifyInstance, deps: PeopleRouteDeps) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.patch(
    '/api/v1/people/:id',
    {
      config: { access: MASTER },
      schema: {
        params,
        body: personUpdateSchema,
        response: { 200: personSchema },
      },
    },
    async ({ params: { id }, body }) => {
      assertKnownTopics(deps, body.topics);
      return view(deps, await deps.people.update(id, body));
    },
  );
  typed.delete(
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

/** "Pessoas e permissões" (FR-3): masters only. */
export const peopleRoutes =
  (deps: PeopleRouteDeps): FastifyPluginAsync =>
  async (app) => {
    registerReads(app, deps);
    registerWrites(app, deps);
  };
