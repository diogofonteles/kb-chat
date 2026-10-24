import { SignJWT, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  createTestKeys,
  mintIdToken,
  testVerifier,
} from '../../test/identity-factories.js';
import { AppError } from '../app-error.js';
import {
  GOOGLE_IDENTITY,
  GoogleIdTokenVerifier,
  createGoogleVerifier,
} from './google-id-token-verifier.js';
import { maxAgeOf } from './jwks-cache.js';

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  return err instanceof AppError ? err.code : String(err);
};

describe('GoogleIdTokenVerifier', () => {
  it('accepts a Google-shaped RS256 token and keeps sub, email, name and picture', async () => {
    const keys = await createTestKeys();
    const token = await mintIdToken(keys, {
      email: 'Guest@Example.com',
      picture: 'https://lh3.example/p.png',
    });

    const identity = await testVerifier(keys).verify(token);

    expect(identity).toEqual({
      sub: '1000001',
      email: 'guest@example.com',
      emailVerified: true,
      name: 'Guest',
      picture: 'https://lh3.example/p.png',
    });
  });

  it('accepts the issuer without the scheme too', async () => {
    const keys = await createTestKeys();
    const token = await mintIdToken(keys, { iss: 'accounts.google.com' });
    await expect(testVerifier(keys).verify(token)).resolves.toMatchObject({
      sub: '1000001',
    });
  });

  it.each([
    ['another audience', { aud: 'someone-else.apps.googleusercontent.com' }],
    ['another issuer', { iss: 'https://evil.example' }],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 600 }],
    [
      'a token issued in the future',
      { iat: Math.floor(Date.now() / 1000) + 600 },
    ],
    ['a token without e-mail', { email: undefined }],
  ])('refuses %s with UNAUTHENTICATED', async (_case, claims) => {
    const keys = await createTestKeys();
    const token = await mintIdToken(keys, claims);
    expect(await codeOf(testVerifier(keys).verify(token))).toBe(
      'UNAUTHENTICATED',
    );
  });

  it('tolerates a small clock skew', async () => {
    const keys = await createTestKeys();
    const token = await mintIdToken(keys, {
      iat: Math.floor(Date.now() / 1000) + 30,
    });
    await expect(testVerifier(keys).verify(token)).resolves.toBeDefined();
  });

  it('reports an unverified e-mail (the route refuses it)', async () => {
    const keys = await createTestKeys();
    const token = await mintIdToken(keys, { email_verified: 'false' });
    const identity = await testVerifier(keys).verify(token);
    expect(identity.emailVerified).toBe(false);
  });

  it('refuses a token signed by another key or with a symmetric algorithm', async () => {
    const keys = await createTestKeys();
    const other = await generateKeyPair('RS256');
    const forged = await mintIdToken({
      privateKey: other.privateKey,
      kid: keys.kid,
    });
    const hs256 = await new SignJWT({
      sub: '1',
      email: 'a@b.c',
      email_verified: true,
    })
      .setProtectedHeader({ alg: 'HS256', kid: keys.kid })
      .setIssuer('https://accounts.google.com')
      .setAudience('test-client.apps.googleusercontent.com')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('a-shared-secret-of-enough-length!!'));
    const verifier = testVerifier(keys);

    expect(await codeOf(verifier.verify(forged))).toBe('UNAUTHENTICATED');
    expect(await codeOf(verifier.verify(hs256))).toBe('UNAUTHENTICATED');
    expect(await codeOf(verifier.verify('not-a-jwt-at-all-really'))).toBe(
      'UNAUTHENTICATED',
    );
  });

  it('keeps the keys for their Cache-Control max-age, then downloads them again', async () => {
    const keys = await createTestKeys({ cacheControl: 'public, max-age=600' });
    let now = Date.now();
    const verifier = testVerifier(keys, () => now);
    const token = await mintIdToken(keys);

    await verifier.verify(token);
    await verifier.verify(token);
    expect(keys.downloads()).toBe(1);

    now += 601_000;
    await verifier.verify(
      await mintIdToken(keys, {
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 3600,
      }),
    );
    expect(keys.downloads()).toBe(2);
  });

  it('downloads again for an unknown key id (rotation), at most every 30 s', async () => {
    const keys = await createTestKeys();
    let now = Date.now();
    const verifier = testVerifier(keys, () => now);
    await verifier.verify(await mintIdToken(keys));
    const rotated = await mintIdToken(keys, {}, { kid: 'key-2' });

    expect(await codeOf(verifier.verify(rotated))).toBe('UNAUTHENTICATED');
    expect(keys.downloads()).toBe(1);
    now += 31_000;
    expect(await codeOf(verifier.verify(rotated))).toBe('UNAUTHENTICATED');
    expect(keys.downloads()).toBe(2);
  });

  it('reports unreachable keys as AUTH_UNAVAILABLE, not as a bad token', async () => {
    const keys = await createTestKeys();
    const verifier = new GoogleIdTokenVerifier({
      clientId: 'test-client.apps.googleusercontent.com',
      jwksUrl: 'https://keys.test/certs',
      issuers: ['https://accounts.google.com'],
      fetch: async () => new Response('down', { status: 503 }),
    });
    expect(await codeOf(verifier.verify(await mintIdToken(keys)))).toBe(
      'AUTH_UNAVAILABLE',
    );
  });
});

describe('the production verifier', () => {
  it('can only trust Google: its issuer and keys are fixed, not configurable', async () => {
    expect(GOOGLE_IDENTITY).toEqual({
      jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
      issuers: ['accounts.google.com', 'https://accounts.google.com'],
    });
    expect(Object.isFrozen(GOOGLE_IDENTITY)).toBe(true);
    const requested: string[] = [];
    const verifier = createGoogleVerifier('client', async (url) => {
      requested.push(String(url));
      return Response.json({ keys: [] });
    });
    const keys = await createTestKeys();
    expect(await codeOf(verifier.verify(await mintIdToken(keys)))).toBe(
      'UNAUTHENTICATED',
    );
    expect(requested).toEqual([GOOGLE_IDENTITY.jwksUrl]);
  });
});

describe('maxAgeOf', () => {
  it.each([
    ['public, max-age=21110, must-revalidate', 21110],
    ['no-cache', 3600],
    [null, 3600],
    ['max-age=999999', 86400],
  ])('reads %s as %i seconds', (header, seconds) => {
    expect(maxAgeOf(header)).toBe(seconds);
  });
});
