import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@kb-chat/contracts';
import { MemoryPeopleStore } from '../src/adapters/memory-people-store.js';
import { MemorySessionStore } from '../src/adapters/memory-session-store.js';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps, type AuthDeps } from '../src/app.js';
import {
  PeopleService,
  SESSION_COOKIE,
  SessionService,
  type StoredPerson,
} from '../src/modules/auth/index.js';
import type { IdentityVerifierPort } from '../src/ports/identity-verifier.js';

export const TEST_OWNER_EMAIL = 'owner@example.com';

/** Refuses every credential: the tests that sign in for real use identity-factories. */
const refusingVerifier: IdentityVerifierPort = {
  verify: () => Promise.reject(new Error('no identity provider in this test')),
};

export interface TestAuth extends AuthDeps {
  readonly memorySessions: MemorySessionStore;
}

/** In-memory people (the owner as the first master) and sessions. */
export function createTestAuth(
  verifier: IdentityVerifierPort = refusingVerifier,
): TestAuth {
  const memorySessions = new MemorySessionStore();
  return {
    people: new PeopleService({
      store: new MemoryPeopleStore(),
      ownerEmail: TEST_OWNER_EMAIL,
    }),
    sessions: new SessionService({ store: memorySessions }),
    verifier,
    memorySessions,
  };
}

/** The headers of a signed-in browser: the session cookie and the CSRF header. */
export const sessionHeaders = (token: string): Record<string, string> => ({
  cookie: `${SESSION_COOKIE}=${token}`,
  [CSRF_HEADER]: CSRF_HEADER_VALUE,
});

/**
 * Signs a person in as Google would (binding their `sub`), inviting them first unless they
 * are the owner, and returns their person and request headers.
 */
export async function signInAs(
  auth: AuthDeps,
  email: string = TEST_OWNER_EMAIL,
): Promise<{ person: StoredPerson; headers: Record<string, string> }> {
  const known = (await auth.people.list()).some((p) => p.email === email);
  if (!known) await auth.people.invite(email, TEST_OWNER_EMAIL);
  const person = await auth.people.signIn({
    sub: `sub-${email}`,
    email,
    emailVerified: true,
    name: email.split('@')[0] ?? email,
    picture: null,
  });
  const token = await auth.sessions.create(person.id);
  return { person, headers: sessionHeaders(token) };
}

/**
 * `buildApp` with in-memory sign-in and the owner signed in: the owner's session headers
 * are merged into `headers` (the tests' shared HOST object) once the app is built.
 */
export const signedInApp =
  (headers: Record<string, string>) =>
  async (deps: Omit<AppDeps, 'auth'>): Promise<FastifyInstance> => {
    const auth = createTestAuth();
    const app = await buildApp({ ...deps, auth });
    Object.assign(headers, (await signInAs(auth)).headers);
    return app;
  };
