import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWTPayload,
} from 'jose';
import { GoogleIdTokenVerifier } from '../src/adapters/google-id-token-verifier.js';

export const TEST_CLIENT_ID = 'test-client.apps.googleusercontent.com';
export const TEST_JWKS_URL = 'https://keys.test/certs';
export const GOOGLE_ISSUER = 'https://accounts.google.com';

/** A locally generated RS256 key and a fake JWKS endpoint: no network (KBC-010). */
export interface TestKeys {
  readonly privateKey: CryptoKey;
  readonly kid: string;
  readonly fetch: typeof fetch;
  /** How many times the JWKS was downloaded. */
  readonly downloads: () => number;
}

export async function createTestKeys(
  options: { kid?: string; cacheControl?: string } = {},
): Promise<TestKeys> {
  const kid = options.kid ?? 'key-1';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256' };
  let downloads = 0;
  const fakeFetch: typeof fetch = async () => {
    downloads += 1;
    return Response.json(
      { keys: [jwk] },
      { headers: { 'cache-control': options.cacheControl ?? 'max-age=600' } },
    );
  };
  return { privateKey, kid, fetch: fakeFetch, downloads: () => downloads };
}

export interface TokenClaims extends JWTPayload {
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
}

/** A Google-shaped ID token; every field can be overridden to make it invalid. */
export function mintIdToken(
  keys: Pick<TestKeys, 'privateKey' | 'kid'>,
  claims: TokenClaims = {},
  header: { alg?: string; kid?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: GOOGLE_ISSUER,
    aud: TEST_CLIENT_ID,
    sub: '1000001',
    email: 'guest@example.com',
    email_verified: true,
    name: 'Guest',
    iat: now,
    exp: now + 3600,
    ...claims,
  })
    .setProtectedHeader({
      alg: header.alg ?? 'RS256',
      kid: header.kid ?? keys.kid,
    })
    .sign(keys.privateKey);
}

export const testVerifier = (keys: TestKeys, now?: () => number) =>
  new GoogleIdTokenVerifier({
    clientId: TEST_CLIENT_ID,
    jwksUrl: TEST_JWKS_URL,
    issuers: ['accounts.google.com', GOOGLE_ISSUER],
    fetch: keys.fetch,
    now,
  });
