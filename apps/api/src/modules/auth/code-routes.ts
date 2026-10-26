import {
  acceptedSchema,
  codeRequestSchema,
  codeVerifySchema,
  meSchema,
  normalizePhone,
  type CodeChannel,
} from '@kb-chat/contracts';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import { PUBLIC } from './access.js';
import { deliverLater, type Notifier } from './notifier.js';
import type { OneTimeCodes } from './one-time-codes.js';
import type { SendLimits } from './send-limits.js';
import { openSession, type SessionOpening } from './session-reply.js';

export interface CodeRouteDeps extends SessionOpening {
  readonly codes: OneTimeCodes;
  readonly notifier: Notifier;
  readonly limits: SendLimits;
  /** Verifications per minute per client. */
  readonly verifyRatePerMinute: number;
}

const invalidCode = (): AppError =>
  new AppError('INVALID_CODE', 'The code is wrong or expired');

/** An email in lower case or a phone in E.164, as people and codes are keyed. */
export function identifierOf(raw: string, channel: CodeChannel): string {
  const value = raw.trim();
  if (channel === 'sms') {
    const phone = normalizePhone(value);
    if (!phone) throw new AppError('VALIDATION_FAILED', 'Invalid phone number');
    return phone;
  }
  if (!z.email().safeParse(value).success)
    throw new AppError('VALIDATION_FAILED', 'Invalid e-mail');
  return value.toLowerCase();
}

const channelOf = (raw: string): CodeChannel =>
  raw.includes('@') ? 'email' : 'sms';

/** Counts the send for every identifier alike, then sends only to a person (BR-1, BR-3). */
function requestCode(app: FastifyInstance, deps: CodeRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/auth/code',
    {
      config: { access: PUBLIC },
      schema: { body: codeRequestSchema, response: { 202: acceptedSchema } },
    },
    async (request, reply) => {
      const { channel } = request.body;
      if (channel === 'sms' && !deps.notifier.smsEnabled)
        throw new AppError('VALIDATION_FAILED', 'SMS is not available');
      const identifier = identifierOf(request.body.identifier, channel);
      if (!deps.limits.take({ purpose: 'login', identifier, ip: request.ip }))
        throw new AppError('RATE_LIMITED', 'Too many codes requested');
      deliverLater(request.log, () =>
        sendLoginCode(deps, { identifier, channel }),
      );
      return reply.code(202).send({});
    },
  );
}

async function sendLoginCode(
  deps: CodeRouteDeps,
  to: { readonly identifier: string; readonly channel: CodeChannel },
): Promise<void> {
  const person = await deps.people.findByIdentifier(to.identifier);
  if (!person) return;
  const value = await deps.codes.issue(
    { purpose: 'login', identifier: to.identifier },
    { channel: to.channel },
  );
  await deps.notifier.sendCode(
    { channel: to.channel, address: to.identifier },
    { purpose: 'login', value },
  );
}

function verifyCode(app: FastifyInstance, deps: CodeRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/auth/code/verify',
    {
      config: {
        access: PUBLIC,
        rateLimit: { max: deps.verifyRatePerMinute, timeWindow: '1 minute' },
      },
      schema: { body: codeVerifySchema, response: { 200: meSchema } },
    },
    async (request, reply) => {
      const raw = request.body.identifier;
      const identifier = identifierOf(raw, channelOf(raw));
      const code = await deps.codes.verify(
        { purpose: 'login', identifier },
        request.body.code,
      );
      // A person revoked after the code went out does not get in either (BR-1).
      const person = code && (await deps.people.findByIdentifier(identifier));
      if (!person) throw invalidCode();
      const signedIn = await deps.people.signInWithCode(person.id);
      return openSession(deps, signedIn, { request, reply });
    },
  );
}

/** Passwordless sign-in with a one-time code by email or SMS (KBC-014 FR-5, ADR 0011). */
export const codeRoutes =
  (deps: CodeRouteDeps): FastifyPluginAsync =>
  async (app) => {
    requestCode(app, deps);
    verifyCode(app, deps);
  };
