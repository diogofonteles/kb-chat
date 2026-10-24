import {
  authConfigSchema,
  googleLoginRequestSchema,
  meSchema,
} from '@kb-chat/contracts';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { IdentityVerifierPort } from '../../ports/identity-verifier.js';
import { PUBLIC, SIGNED_IN, viewerOf } from './access.js';
import {
  SESSION_COOKIE,
  clearedSessionCookie,
  isSecureHost,
  readCookie,
  sessionCookie,
} from './cookie.js';
import type { PeopleService } from './people-service.js';
import { toMe } from './person.js';
import type { SessionService } from './session-service.js';

export interface AuthRouteDeps {
  readonly people: PeopleService;
  readonly sessions: SessionService;
  readonly verifier: IdentityVerifierPort;
  /** Public: the web renders the Google button with it. */
  readonly googleClientId: string | null;
  /** Sign-in attempts per minute per client (ND-22). */
  readonly loginRatePerMinute: number;
  /** Every collection slug in the vault (a master sees them all). */
  readonly topics: () => readonly string[];
}

export const sessionTokenOf = (request: FastifyRequest): string | undefined =>
  readCookie(request.headers.cookie, SESSION_COOKIE);

async function signIn(
  deps: AuthRouteDeps,
  credential: string,
  { request, reply }: { request: FastifyRequest; reply: FastifyReply },
) {
  const identity = await deps.verifier.verify(credential);
  if (!identity.emailVerified)
    throw new AppError('UNAUTHENTICATED', 'The e-mail is not verified');
  const person = await deps.people.signIn(identity);
  const token = await deps.sessions.create(person.id);
  request.log.info({ personId: person.id }, 'signed in');
  reply.header(
    'set-cookie',
    sessionCookie(token, isSecureHost(request.headers.host)),
  );
  return toMe(deps.people.viewerOf(person), deps.topics());
}

function registerLogin(app: FastifyInstance, deps: AuthRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/auth/google',
    {
      config: {
        access: PUBLIC,
        rateLimit: { max: deps.loginRatePerMinute, timeWindow: '1 minute' },
      },
      schema: { body: googleLoginRequestSchema, response: { 200: meSchema } },
    },
    (request, reply) =>
      signIn(deps, request.body.credential, { request, reply }),
  );
}

function registerSession(app: FastifyInstance, deps: AuthRouteDeps) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    '/api/v1/auth/config',
    {
      config: { access: PUBLIC },
      schema: { response: { 200: authConfigSchema } },
    },
    async () => ({ googleClientId: deps.googleClientId }),
  );
  typed.get(
    '/api/v1/me',
    { config: { access: SIGNED_IN }, schema: { response: { 200: meSchema } } },
    async (request) => toMe(viewerOf(request), deps.topics()),
  );
}

function registerLogout(app: FastifyInstance, deps: AuthRouteDeps) {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/auth/logout',
    {
      config: { access: PUBLIC },
      schema: { response: { 204: z.undefined() } },
    },
    async (request, reply) => {
      const token = sessionTokenOf(request);
      if (token) await deps.sessions.destroy(token);
      const secure = isSecureHost(request.headers.host);
      return reply
        .header('set-cookie', clearedSessionCookie(secure))
        .code(204)
        .send();
    },
  );
}

/** Sign-in with Google Identity Services, sign-out and who is signed in (ADR 0008). */
export const authRoutes =
  (deps: AuthRouteDeps): FastifyPluginAsync =>
  async (app) => {
    registerLogin(app, deps);
    registerSession(app, deps);
    registerLogout(app, deps);
  };
