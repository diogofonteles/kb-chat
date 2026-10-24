import { describe, expect, it, vi } from 'vitest';
import { MemoryPeopleStore } from '../../adapters/memory-people-store.js';
import { AppError } from '../../app-error.js';
import type { VerifiedIdentity } from '../../ports/identity-verifier.js';
import { PEOPLE_CACHE_MS, PeopleService } from './people-service.js';
import { OWNER_PRINCIPAL } from './person.js';

const OWNER = 'owner@example.com';

const identity = (email: string, sub = `sub-${email}`): VerifiedIdentity => ({
  sub,
  email,
  emailVerified: true,
  name: email.split('@')[0] ?? email,
  picture: null,
});

const service = (store = new MemoryPeopleStore()) =>
  new PeopleService({ store, ownerEmail: OWNER });

const codeOf = async (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'resolved',
    (err: unknown) => (err instanceof AppError ? err.code : String(err)),
  );

describe('PeopleService', () => {
  it('starts with the owner as the first master and saves it', async () => {
    const store = new MemoryPeopleStore();
    const people = await service(store).list();

    expect(people).toEqual([
      expect.objectContaining({ email: OWNER, role: 'master', sub: null }),
    ]);
    expect(await store.read()).toMatchObject({
      version: 1,
      people: [{ email: OWNER }],
    });
  });

  it('invites with search on no collection, and refuses a second invite (BR-3)', async () => {
    const people = service();
    const invited = await people.invite('Guest@Example.com', OWNER);

    expect(invited).toMatchObject({
      email: 'guest@example.com',
      role: 'member',
      topics: [],
      features: ['search'],
      invitedBy: OWNER,
      lastLoginAt: null,
    });
    expect(await codeOf(people.invite('guest@example.com', OWNER))).toBe(
      'ALREADY_INVITED',
    );
  });

  it('matches the first sign-in by the invited e-mail and binds the Google sub (BR-2)', async () => {
    const people = service();
    const invited = await people.invite('guest@example.com', OWNER);

    const first = await people.signIn(identity('guest@example.com', 'g-1'));
    const again = await people.signIn(identity('guest@example.com', 'g-1'));

    expect(first).toMatchObject({ id: invited.id, sub: 'g-1', name: 'guest' });
    expect(first.lastLoginAt).not.toBeNull();
    expect(again.id).toBe(invited.id);
    expect(people.viewerOf(first)).toMatchObject({
      principal: 'g-1',
      isOwner: false,
    });
  });

  it('refuses an account that was not invited, or another account with an invited e-mail', async () => {
    const people = service();
    await people.invite('guest@example.com', OWNER);
    await people.signIn(identity('guest@example.com', 'g-1'));

    expect(await codeOf(people.signIn(identity('stranger@example.com')))).toBe(
      'NOT_INVITED',
    );
    expect(
      await codeOf(people.signIn(identity('guest@example.com', 'g-2'))),
    ).toBe('NOT_INVITED');
  });

  it('keeps the owner on the `owner` principal of the data written before logins', async () => {
    const people = service();
    const owner = await people.signIn(identity(OWNER, '123456789'));

    expect(people.viewerOf(owner)).toMatchObject({
      principal: OWNER_PRINCIPAL,
      isOwner: true,
    });
  });

  it('lets a master grant collections, features and the master role', async () => {
    const people = service();
    const guest = await people.invite('guest@example.com', OWNER);

    const updated = await people.update(guest.id, {
      topics: ['hermetismo', 'hermetismo'],
      features: ['search', 'research'],
      role: 'master',
    });

    expect(updated).toMatchObject({
      topics: ['hermetismo'],
      features: ['search', 'research'],
      role: 'master',
    });
  });

  it('keeps at least one master (AC-7) and the owner a master', async () => {
    const people = service();
    const [owner] = await people.list();
    const other = await people.invite('second@example.com', OWNER);
    await people.update(other.id, { role: 'master' });

    expect(
      await codeOf(people.update(owner?.id ?? '', { role: 'member' })),
    ).toBe('OWNER_PROTECTED');
    await people.update(other.id, { role: 'member' });
    expect(
      await codeOf(people.update(owner?.id ?? '', { role: 'member' })),
    ).toBe('LAST_MASTER');
    expect(await codeOf(people.revoke(owner?.id ?? ''))).toBe('LAST_MASTER');
  });

  it('revokes a person, and refuses to remove the owner while others are masters', async () => {
    const people = service();
    const [owner] = await people.list();
    const guest = await people.invite('guest@example.com', OWNER);
    const other = await people.invite('second@example.com', OWNER);
    await people.update(other.id, { role: 'master' });

    await people.revoke(guest.id);

    expect(await people.find(guest.id)).toBeNull();
    expect(await codeOf(people.revoke(owner?.id ?? ''))).toBe(
      'OWNER_PROTECTED',
    );
    expect(
      await codeOf(people.revoke('00000000-0000-4000-8000-000000000000')),
    ).toBe('NOT_FOUND');
  });

  it('reads people.json again after a minute (a hand edit applies within BR-4)', async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryPeopleStore();
      const people = service(store);
      await people.invite('guest@example.com', OWNER);
      const document = (await store.read()) as { people: { email: string }[] };
      await store.write({ version: 1, people: document.people.slice(0, 1) });

      expect(await people.list()).toHaveLength(2);
      vi.advanceTimersByTime(PEOPLE_CACHE_MS + 1);
      expect(await people.list()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed on an invalid people.json', async () => {
    const store = new MemoryPeopleStore();
    await store.write({ version: 1, people: [{ email: 'not a person' }] });
    expect(await codeOf(service(store).list())).toBe('INTERNAL');
  });

  it('works without an owner e-mail (no one is added)', async () => {
    const people = new PeopleService({ store: new MemoryPeopleStore() });
    expect(await people.list()).toEqual([]);
  });
});
