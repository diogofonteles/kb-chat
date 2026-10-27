import {
  inviteProfileCreateSchema,
  inviteProfileListSchema,
  inviteProfileSchema,
  inviteProfileUpdateSchema,
} from '@kb-chat/contracts';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { RouteAccess } from '../auth/index.js';
import type { InviteProfilesService } from './invite-profiles-service.js';

const MASTER: RouteAccess = { master: true };

/** Every collection slug in the vault: a profile only grants those (as the people editor). */
type Topics = () => readonly string[];

function assertKnownTopics(topics: Topics, preset?: { topics: string[] }) {
  const known = new Set(topics());
  const unknown = (preset?.topics ?? []).filter((topic) => !known.has(topic));
  if (unknown.length > 0)
    throw new AppError('VALIDATION_FAILED', 'Unknown collection', {
      details: { topics: unknown },
    });
}
const params = z.object({ id: z.uuid() });

function registerReads(
  app: FastifyInstance,
  profiles: InviteProfilesService,
  topics: Topics,
) {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.get(
    '/api/v1/invite-profiles',
    {
      config: { access: MASTER },
      schema: { response: { 200: inviteProfileListSchema } },
    },
    async () => ({ items: [...profiles.list()] }),
  );
  routes.post(
    '/api/v1/invite-profiles',
    {
      config: { access: MASTER },
      schema: {
        body: inviteProfileCreateSchema,
        response: { 201: inviteProfileSchema },
      },
    },
    async (request, reply) => {
      assertKnownTopics(topics, request.body.preset);
      return reply.code(201).send(await profiles.create(request.body));
    },
  );
}

function registerWrites(
  app: FastifyInstance,
  profiles: InviteProfilesService,
  topics: Topics,
) {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.put(
    '/api/v1/invite-profiles/:id',
    {
      config: { access: MASTER },
      schema: {
        params,
        body: inviteProfileUpdateSchema,
        response: { 200: inviteProfileSchema },
      },
    },
    async (request) => {
      assertKnownTopics(topics, request.body.preset);
      return profiles.update(request.params.id, request.body);
    },
  );
}

function registerDelete(app: FastifyInstance, profiles: InviteProfilesService) {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  routes.delete(
    '/api/v1/invite-profiles/:id',
    {
      config: { access: MASTER },
      schema: { params, response: { 204: z.undefined() } },
    },
    async (request, reply) => {
      await profiles.remove(request.params.id);
      return reply.code(204).send();
    },
  );
}

/** "Perfis de convite" (KBC-028): masters only. */
export const inviteProfilesRoutes =
  (profiles: InviteProfilesService, topics: Topics): FastifyPluginAsync =>
  async (app) => {
    registerReads(app, profiles, topics);
    registerWrites(app, profiles, topics);
    registerDelete(app, profiles);
  };
