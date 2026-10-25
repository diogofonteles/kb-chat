import { describe, expect, it } from 'vitest';
import { MemoryDocumentStore } from '../../adapters/memory-document-store.js';
import {
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  OneTimeCodes,
} from './one-time-codes.js';

const LOGIN = { purpose: 'login', identifier: 'ana@example.com' } as const;

function setup(codes = ['123456', '654321']) {
  const store = new MemoryDocumentStore();
  let now = Date.parse('2026-10-25T10:00:00.000Z');
  const queue = [...codes];
  const service = new OneTimeCodes({
    store,
    now: () => new Date(now),
    generate: () => queue.shift() ?? '000000',
  });
  return { service, store, advance: (ms: number) => (now += ms) };
}

describe('OneTimeCodes (KBC-014 BR-4, NFR-1)', () => {
  it('issues a 6-digit code that opens once', async () => {
    const { service } = setup();
    const code = await service.issue(LOGIN, { channel: 'email' });

    expect(code).toBe('123456');
    expect(await service.verify(LOGIN, '123456')).toMatchObject({
      channel: 'email',
    });
    expect(await service.verify(LOGIN, '123456')).toBeNull();
  });

  it('stores only a salted hash, never the code', async () => {
    const { service, store } = setup();
    await service.issue(LOGIN, { channel: 'email' });

    const saved = JSON.stringify(await store.read());
    expect(saved).not.toContain('123456');
    expect(saved).toMatch(/"salt":"[A-Za-z0-9_-]{22}"/);
  });

  it('refuses the right code after ten minutes', async () => {
    const { service, advance } = setup();
    await service.issue(LOGIN, { channel: 'email' });
    advance(CODE_TTL_MS + 1);

    expect(await service.verify(LOGIN, '123456')).toBeNull();
  });

  it('burns the code after five wrong attempts', async () => {
    const { service } = setup();
    await service.issue(LOGIN, { channel: 'email' });
    for (let attempt = 1; attempt < MAX_CODE_ATTEMPTS; attempt += 1)
      expect(await service.verify(LOGIN, '000000')).toBeNull();
    expect(await service.verify(LOGIN, '123456')).toMatchObject({
      identifier: 'ana@example.com',
    });

    await service.issue(LOGIN, { channel: 'email' });
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1)
      expect(await service.verify(LOGIN, '000000')).toBeNull();
    expect(await service.verify(LOGIN, '654321')).toBeNull();
  });

  it('replaces the previous code of the same identifier and purpose', async () => {
    const { service } = setup();
    await service.issue(LOGIN, { channel: 'email' });
    await service.issue(LOGIN, { channel: 'email' });

    expect(await service.verify(LOGIN, '123456')).toBeNull();
    expect(await service.verify(LOGIN, '654321')).not.toBeNull();
  });

  it('keeps sign-up and sign-in codes apart and returns the sign-up form', async () => {
    const { service } = setup();
    const signup = { purpose: 'signup', identifier: LOGIN.identifier } as const;
    await service.issue(signup, {
      channel: 'email',
      payload: { firstName: 'Ana' },
    });

    expect(await service.verify(LOGIN, '123456')).toBeNull();
    expect(await service.verify(signup, '123456')).toMatchObject({
      payload: { firstName: 'Ana' },
    });
  });

  it('generates six random digits by default', async () => {
    const service = new OneTimeCodes({ store: new MemoryDocumentStore() });
    const codes = await Promise.all(
      ['a', 'b', 'c'].map((name) =>
        service.issue(
          { purpose: 'login', identifier: `${name}@x.co` },
          { channel: 'email' },
        ),
      ),
    );
    for (const code of codes) expect(code).toMatch(/^\d{6}$/);
  });

  it('hashes a guess even when there is no live code, so timing tells nothing (BR-3, NFR-3)', async () => {
    const hashed: string[] = [];
    const service = new OneTimeCodes({
      store: new MemoryDocumentStore(),
      generate: () => '123456',
      onHash: (code) => hashed.push(code),
    });
    await service.issue(LOGIN, { channel: 'email' });
    hashed.length = 0;

    expect(await service.verify(LOGIN, '000000')).toBeNull();
    expect(
      await service.verify(
        { purpose: 'login', identifier: 'nobody@example.com' },
        '000000',
      ),
    ).toBeNull();

    expect(hashed).toEqual(['000000', '000000']);
  });
});
