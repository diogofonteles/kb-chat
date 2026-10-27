import {
  inviteProfileCreateSchema,
  inviteProfileListSchema,
  inviteProfileSchema,
  inviteProfileUpdateSchema,
} from '@kb-chat/contracts';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteAccess } from '../auth/index.js';
import type { InviteProfilesService } from './invite-profiles-service.js';

const MASTER: RouteAccess = { master: true };
const params = z.object({ id: z.uuid() });

function registerReads(app: FastifyInstance, profiles: InviteProfilesService) {
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
    async (request, reply) =>
      reply.code(201).send(await profiles.create(request.body)),
  );
}

function registerWrites(app: FastifyInstance, profiles: InviteProfilesService) {
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
    async (request) => profiles.update(request.params.id, request.body),
  );
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
  (profiles: InviteProfilesService): FastifyPluginAsync =>
  async (app) => {
    registerReads(app, profiles);
    registerWrites(app, profiles);
  };
