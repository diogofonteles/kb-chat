import { personIdSchema, personSchema } from '@kb-chat/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { viewerOf, type RouteAccess } from './access.js';
import type { Invitations } from './invitations.js';
import type { PeopleService } from './people-service.js';
import { toPerson } from './person.js';

export interface InvitationRouteDeps {
  readonly people: PeopleService;
  readonly invitations: Invitations;
}

const MASTER: RouteAccess = { master: true };

/** "Reenviar convite" (KBC-026 FR-3): masters only, limited per invitee. */
export const invitationRoutes =
  (deps: InvitationRouteDeps): FastifyPluginAsync =>
  async (app) => {
    app.withTypeProvider<ZodTypeProvider>().post(
      '/api/v1/people/:id/invitation',
      {
        config: { access: MASTER },
        schema: {
          params: z.object({ id: personIdSchema }),
          response: { 200: personSchema },
        },
      },
      async (request) => {
        const inviter = viewerOf(request).person;
        const person = await deps.invitations.resend(
          request.params.id,
          inviter,
          request.log,
        );
        return toPerson(person, deps.people.isOwner(person));
      },
    );
  };
