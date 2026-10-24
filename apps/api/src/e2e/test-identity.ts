import { createHash, randomUUID } from 'node:crypto';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
} from 'jose';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GoogleIdTokenVerifier } from '../adapters/google-id-token-verifier.js';
import { PUBLIC } from '../modules/auth/index.js';

/**
 * A stand-in for Google, for the E2E server only (KBC-010): its own RS256 key, its JWKS
 * served under /api/e2e/jwks and test ID tokens minted under /api/e2e/token. The production
 * composition (main) never imports this file; a test keeps it that way.
 */
export const E2E_ISSUER = 'https://accounts.e2e.kb-chat.test';
export const E2E_CLIENT_ID = 'e2e-client-id.apps.kb-chat.test';
const KID = 'e2e-key-1';

const tokenRequestSchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(100).optional(),
  emailVerified: z.boolean().default(true),
});

export interface TestIdentity {
  readonly verifier: GoogleIdTokenVerifier;
  /** Registers the JWKS and token routes on the E2E app. */
  readonly register: (app: FastifyInstance) => void;
}

/** A stable `sub` per e-mail, so one test person is one Google account across sign-ins. */
const subOf = (email: string): string =>
  BigInt(
    `0x${createHash('sha256').update(email).digest('hex').slice(0, 15)}`,
  ).toString();

async function mint(
  privateKey: CryptoKey,
  request: z.output<typeof tokenRequestSchema>,
): Promise<string> {
  return new SignJWT({
    email: request.email,
    email_verified: request.emailVerified,
    name: request.name ?? request.email.split('@')[0],
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(E2E_ISSUER)
    .setAudience(E2E_CLIENT_ID)
    .setSubject(subOf(request.email))
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

export async function createTestIdentity(port: number): Promise<TestIdentity> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk: JWK = {
    ...(await exportJWK(publicKey)),
    kid: KID,
    alg: 'RS256',
    use: 'sig',
  };
  const verifier = new GoogleIdTokenVerifier({
    clientId: E2E_CLIENT_ID,
    jwksUrl: `http://127.0.0.1:${port}/api/e2e/jwks`,
    issuers: [E2E_ISSUER],
  });
  return {
    verifier,
    register: (app) => registerRoutes(app, { jwk, privateKey }),
  };
}

function registerRoutes(
  app: FastifyInstance,
  { jwk, privateKey }: { jwk: JWK; privateKey: CryptoKey },
): void {
  app.get(
    '/api/e2e/jwks',
    { config: { access: PUBLIC } },
    async (_request, reply) =>
      reply
        .header('cache-control', 'public, max-age=300')
        .send({ keys: [jwk] }),
  );
  app.post(
    '/api/e2e/token',
    { config: { access: PUBLIC } },
    async (request) => ({
      credential: await mint(
        privateKey,
        tokenRequestSchema.parse(request.body),
      ),
    }),
  );
}
