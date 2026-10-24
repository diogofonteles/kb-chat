import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsSessionStore } from '../../adapters/fs-session-store.js';
import { MemorySessionStore } from '../../adapters/memory-session-store.js';
import {
  SESSION_TTL_MS,
  SessionService,
  sessionIdOf,
} from './session-service.js';

const HOUR = 3600 * 1000;

describe('SessionService', () => {
  it('opens a session for a random token and stores only its hash', async () => {
    const store = new MemorySessionStore();
    const sessions = new SessionService({ store });

    const token = await sessions.create('person-1');

    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(await store.get(token)).toBeNull();
    expect(await sessions.resolve(token)).toMatchObject({
      id: sessionIdOf(token),
      personId: 'person-1',
    });
    expect(await sessions.resolve('another-token')).toBeNull();
  });

  it('slides the 30-day expiry forward as the session is used, at most once an hour', async () => {
    let now = new Date('2026-10-01T10:00:00Z');
    const sessions = new SessionService({
      store: new MemorySessionStore(),
      now: () => now,
    });
    const token = await sessions.create('person-1');
    const first = await sessions.resolve(token);

    now = new Date(now.getTime() + HOUR / 2);
    expect((await sessions.resolve(token))?.expiresAt).toBe(first?.expiresAt);
    now = new Date(now.getTime() + 2 * HOUR);
    const slid = await sessions.resolve(token);

    expect(Date.parse(slid?.expiresAt ?? '')).toBe(
      now.getTime() + SESSION_TTL_MS,
    );
  });

  it('ends an expired session', async () => {
    let now = new Date('2026-10-01T10:00:00Z');
    const store = new MemorySessionStore();
    const sessions = new SessionService({ store, now: () => now });
    const token = await sessions.create('person-1');

    now = new Date(now.getTime() + SESSION_TTL_MS + 1);

    expect(await sessions.resolve(token)).toBeNull();
    expect(await store.get(sessionIdOf(token))).toBeNull();
  });

  it('ends every session of a revoked person and only theirs (BR-4)', async () => {
    const sessions = new SessionService({ store: new MemorySessionStore() });
    const a = await sessions.create('person-1');
    const b = await sessions.create('person-1');
    const c = await sessions.create('person-2');

    expect(await sessions.destroyFor('person-1')).toBe(2);
    expect(await sessions.resolve(a)).toBeNull();
    expect(await sessions.resolve(b)).toBeNull();
    expect(await sessions.resolve(c)).not.toBeNull();
    await sessions.destroy(c);
    expect(await sessions.resolve(c)).toBeNull();
  });
});

describe('FsSessionStore', () => {
  it('keeps one owner-only file per session hash and ignores ids that are not hashes', async () => {
    const dir = join(
      await mkdtemp(join(tmpdir(), 'kbchat-sessions-')),
      'sessions',
    );
    const store = new FsSessionStore(dir);
    const sessions = new SessionService({ store });
    const token = await sessions.create('person-1');
    await sessions.create('person-2');

    const files = await readdir(dir);
    expect(files).toContain(`${sessionIdOf(token)}.json`);
    expect((await stat(join(dir, files[0] ?? ''))).mode & 0o777).toBe(0o600);
    expect(await store.get('../../etc/passwd')).toBeNull();
    await store.remove('../escape');
    expect(await sessions.resolve(token)).toMatchObject({
      personId: 'person-1',
    });
    expect(await store.removeFor('person-1')).toBe(1);
    expect(await readdir(dir)).toHaveLength(1);
  });

  it('lists nothing before the first session', async () => {
    const store = new FsSessionStore(
      join(tmpdir(), 'kbchat-missing-sessions-dir'),
    );
    expect(await store.removeFor('anyone')).toBe(0);
  });
});
