import {
  actAsAuditListSchema,
  actAsRequestSchema,
  actingSchema,
  myAccessListSchema,
  personIdSchema,
} from '@kb-chat/contracts';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import { SIGNED_IN, sessionOf, viewerOf } from './access.js';
import type { ActAsService } from './act-as-service.js';
import { mayActAs } from './person.js';

const MASTER = { master: true } as const;

/** "Ver como" from "Pessoas e permissões" (FR-1). */
function registerStart(app: FastifyInstance, actAs: ActAsService): void {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/people/:id/act-as',
    {
      config: { access: MASTER },
      schema: {
        params: z.object({ id: personIdSchema }),
        body: actAsRequestSchema,
        response: { 200: actingSchema },
      },
    },
    async (request) =>
      actAs.start({
        master: viewerOf(request),
        session: sessionOf(request),
        personId: request.params.id,
        reason: request.body.reason,
      }),
  );
}

/** "Voltar para a minha conta" (FR-1). */
function registerStop(app: FastifyInstance, actAs: ActAsService): void {
  app.withTypeProvider<ZodTypeProvider>().delete(
    '/api/v1/act-as',
    {
      config: { access: SIGNED_IN },
      schema: { response: { 204: z.undefined() } },
    },
    async (request, reply) => {
      if (!viewerOf(request).actor)
        throw new AppError('NOT_FOUND', 'Not acting as anyone');
      await actAs.stop(sessionOf(request));
      return reply.code(204).send();
    },
  );
}

/** The audit for masters with the grant, and each person's own accesses (FR-6, FR-7). */
function registerAudit(app: FastifyInstance, actAs: ActAsService): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    '/api/v1/act-as/audit',
    {
      config: { access: MASTER },
      schema: { response: { 200: actAsAuditListSchema } },
    },
    async (request) => {
      if (!mayActAs(viewerOf(request)))
        throw new AppError('FORBIDDEN', 'Acting as a person is not granted');
      return { items: await actAs.audit() };
    },
  );
  typed.get(
    '/api/v1/me/accesses',
    {
      config: { access: SIGNED_IN },
      schema: { response: { 200: myAccessListSchema } },
    },
    async (request) => ({
      items: await actAs.accessesOf(viewerOf(request).person.id),
    }),
  );
}

/** Masters acting as a person, audited (KBC-060, ADR 0027). */
export const actAsRoutes =
  (actAs: ActAsService): FastifyPluginAsync =>
  async (app) => {
    registerStart(app, actAs);
    registerStop(app, actAs);
    registerAudit(app, actAs);
  };
