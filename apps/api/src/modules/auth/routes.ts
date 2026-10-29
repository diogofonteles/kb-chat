import {
  authConfigSchema,
  googleLoginRequestSchema,
  meSchema,
  type CodeChannel,
  type NotInvitedDetails,
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
import type {
  IdentityVerifierPort,
  VerifiedIdentity,
} from '../../ports/identity-verifier.js';
import { PUBLIC, SIGNED_IN, viewerOf } from './access.js';
import {
  SESSION_COOKIE,
  clearedSessionCookie,
  isSecureHost,
  readCookie,
} from './cookie.js';
import type { PeopleService } from './people-service.js';
import { toMe } from './person.js';
import type { SessionService } from './session-service.js';
import { openSession } from './session-reply.js';

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
  /** The media library is on (KB_CHAT_MEDIA); off when not given. */
  readonly mediaEnabled?: boolean;
  /** Where a one-time sign-in code can go (KBC-014 BR-9). */
  readonly codeChannels: readonly CodeChannel[];
  /** Public: the contact the privacy policy names (KBC-016). */
  readonly privacyContactEmail: string | null;
  /** The ticket and request state of a not-invited Google account (ADR 0011). */
  readonly notInvited?: (
    identity: VerifiedIdentity,
  ) => Promise<NotInvitedDetails>;
}

export const sessionTokenOf = (request: FastifyRequest): string | undefined =>
  readCookie(request.headers.cookie, SESSION_COOKIE);

/** Google answered for an account nobody invited: what "Solicitar acesso" needs (ADR 0011). */
async function notInvited(
  deps: AuthRouteDeps,
  identity: VerifiedIdentity,
): Promise<AppError> {
  const details = deps.notInvited ? await deps.notInvited(identity) : undefined;
  return new AppError('NOT_INVITED', 'This account was not invited', {
    details,
  });
}

async function signIn(
  deps: AuthRouteDeps,
  credential: string,
  http: { request: FastifyRequest; reply: FastifyReply },
) {
  const identity = await deps.verifier.verify(credential);
  if (!identity.emailVerified)
    throw new AppError('UNAUTHENTICATED', 'The e-mail is not verified');
  const person = await deps.people.signIn(identity).catch(async (err) => {
    if (err instanceof AppError && err.code === 'NOT_INVITED')
      throw await notInvited(deps, identity);
    throw err;
  });
  return openSession(deps, person, http);
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
    async () => ({
      googleClientId: deps.googleClientId,
      codeChannels: [...deps.codeChannels],
      privacyContactEmail: deps.privacyContactEmail,
    }),
  );
  typed.get(
    '/api/v1/me',
    { config: { access: SIGNED_IN }, schema: { response: { 200: meSchema } } },
    async (request) =>
      toMe(viewerOf(request), {
        topics: deps.topics(),
        media: deps.mediaEnabled ?? false,
      }),
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
