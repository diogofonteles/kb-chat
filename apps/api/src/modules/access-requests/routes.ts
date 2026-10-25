import {
  acceptedSchema,
  accessRequestCreatedSchema,
  accessRequestListSchema,
  googleAccessRequestSchema,
  personSchema,
  signUpRequestSchema,
  signUpVerifySchema,
} from '@kb-chat/contracts';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import {
  PUBLIC,
  deliverLater,
  toPerson,
  viewerOf,
  type Notifier,
  type PeopleService,
  type RequestTickets,
  type RouteAccess,
  type SendLimits,
} from '../auth/index.js';
import type { AccessRequestService } from './access-request-service.js';
import { toAccessRequest } from './request-rules.js';
import type { SignUpFlow } from './sign-up-flow.js';

export interface AccessRequestRouteDeps {
  readonly requests: AccessRequestService;
  readonly flow: SignUpFlow;
  readonly people: PeopleService;
  readonly tickets: RequestTickets;
  readonly notifier: Notifier;
  readonly limits: SendLimits;
  /** Confirmations and Google requests per minute per client. */
  readonly ratePerMinute: number;
}

const MASTER: RouteAccess = { master: true };
const params = z.object({ id: z.uuid() });
const created = { 201: accessRequestCreatedSchema };

function registerSignUp(app: FastifyInstance, deps: AccessRequestRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/access-requests/signup',
    {
      config: { access: PUBLIC },
      schema: { body: signUpRequestSchema, response: { 202: acceptedSchema } },
    },
    async (request, reply) => {
      const identifier = request.body.email.toLowerCase();
      if (!deps.limits.take({ purpose: 'signup', identifier, ip: request.ip }))
        throw new AppError('RATE_LIMITED', 'Too many codes requested');
      deliverLater(request.log, () => deps.flow.start(request.body));
      return reply.code(202).send({});
    },
  );
}

function registerSignUpConfirmation(
  app: FastifyInstance,
  deps: AccessRequestRouteDeps,
) {
  const rateLimit = { max: deps.ratePerMinute, timeWindow: '1 minute' };
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/access-requests/signup/verify',
    {
      config: { access: PUBLIC, rateLimit },
      schema: { body: signUpVerifySchema, response: created },
    },
    async (request, reply) => {
      const { email, code } = request.body;
      const pending = await deps.flow.confirm(email, code);
      request.log.info({ requestId: pending.id }, 'access requested');
      deliverLater(request.log, () => deps.flow.tellMasters(pending));
      return reply.code(201).send({ status: 'pending' as const });
    },
  );
}

function registerGoogle(app: FastifyInstance, deps: AccessRequestRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/access-requests/google',
    {
      config: {
        access: PUBLIC,
        rateLimit: { max: deps.ratePerMinute, timeWindow: '1 minute' },
      },
      schema: { body: googleAccessRequestSchema, response: created },
    },
    async (request, reply) => {
      const identity = deps.tickets.redeem(request.body.ticket);
      const pending = await deps.flow.fromGoogle(
        identity,
        request.body.phone ?? null,
      );
      request.log.info({ requestId: pending.id }, 'access requested');
      deliverLater(request.log, () => deps.flow.tellMasters(pending));
      return reply.code(201).send({ status: 'pending' as const });
    },
  );
}

function registerList(app: FastifyInstance, deps: AccessRequestRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/v1/access-requests',
    {
      config: { access: MASTER },
      schema: { response: { 200: accessRequestListSchema } },
    },
    async () => ({
      items: (await deps.requests.pending()).map(toAccessRequest),
    }),
  );
}

function registerApprove(app: FastifyInstance, deps: AccessRequestRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/access-requests/:id/approve',
    {
      config: { access: MASTER },
      schema: { params, response: { 201: personSchema } },
    },
    async (request, reply) => {
      const by = viewerOf(request).person.email;
      const person = await deps.requests.approve(request.params.id, by);
      request.log.info({ personId: person.id }, 'access request approved');
      const firstName = person.name.split(' ')[0] ?? '';
      deliverLater(request.log, () =>
        deps.notifier.approved(person.email, firstName),
      );
      return reply
        .code(201)
        .send(toPerson(person, deps.people.isOwner(person)));
    },
  );
}

function registerRefuse(app: FastifyInstance, deps: AccessRequestRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/access-requests/:id/refuse',
    {
      config: { access: MASTER },
      schema: { params, response: { 204: z.undefined() } },
    },
    async (request, reply) => {
      const by = viewerOf(request).person.email;
      await deps.requests.refuse(request.params.id, by);
      request.log.info(
        { requestId: request.params.id },
        'access request refused',
      );
      return reply.code(204).send();
    },
  );
}

/** "Solicitar acesso" and "Solicitações pendentes" (KBC-014, ADR 0011). */
export const accessRequestRoutes =
  (deps: AccessRequestRouteDeps): FastifyPluginAsync =>
  async (app) => {
    registerSignUp(app, deps);
    registerSignUpConfirmation(app, deps);
    registerGoogle(app, deps);
    registerList(app, deps);
    registerApprove(app, deps);
    registerRefuse(app, deps);
  };
