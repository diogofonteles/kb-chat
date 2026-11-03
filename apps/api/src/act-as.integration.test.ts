import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OWNER_EMAIL,
  caller,
  closeApp,
  research,
  signIn,
  start,
  withPeople,
  type Call,
  type Started,
} from '../test/ai-app-harness.js';

afterEach(async () => {
  vi.useRealTimers();
  await closeApp();
});

const REASON = 'não vê os marcadores';

/** The owner, a member (Ana) and a second master (Bruno) without the grant. */
async function scene(): Promise<{
  started: Started;
  owner: Call;
  member: Call;
  memberId: string;
  master: Call;
  masterId: string;
}> {
  const started = await start();
  const { owner, member, memberId } = await withPeople(started);
  const invited = await owner('POST', '/api/v1/people', {
    email: 'bruno@example.com',
  });
  const masterId: string = invited.json().id;
  await owner('PATCH', `/api/v1/people/${masterId}`, { role: 'master' });
  const master = caller(
    started.app,
    await signIn(started, 'bruno@example.com'),
  );
  return { started, owner, member, memberId, master, masterId };
}

describe('Acting as a person (KBC-060)', () => {
  it('turns the owner into the person: their collections, features, role and data (AC-1, AC-2)', async () => {
    const { owner, member, memberId } = await scene();
    await member('PUT', '/api/v1/settings', {
      preferences: { theme: 'dark' },
    });
    const ownMe = (await owner('GET', '/api/v1/me')).json();
    expect(ownMe).toMatchObject({ canActAs: true, actingAs: null });

    const started = await owner('POST', `/api/v1/people/${memberId}/act-as`, {
      reason: REASON,
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      person: { id: memberId, email: 'ana@example.com' },
      actor: { email: OWNER_EMAIL },
      reason: REASON,
    });
    const me = (await owner('GET', '/api/v1/me')).json();
    expect(me).toMatchObject({
      email: 'ana@example.com',
      role: 'member',
      isOwner: false,
      canActAs: false,
      topics: ['hermetismo'],
      actingAs: { person: { email: 'ana@example.com' }, reason: REASON },
    });
    expect(me.features).toEqual(['search', 'research', 'own-ai-settings']);
    expect(
      (await owner('GET', '/api/v1/settings')).json().preferences.theme,
    ).toBe('dark');
    // Ana is not a master: nor is the owner while acting as her.
    expect((await owner('GET', '/api/v1/people')).statusCode).toBe(403);

    expect((await owner('DELETE', '/api/v1/act-as')).statusCode).toBe(204);
    expect((await owner('GET', '/api/v1/me')).json()).toMatchObject({
      email: OWNER_EMAIL,
      actingAs: null,
    });
    expect((await owner('DELETE', '/api/v1/act-as')).statusCode).toBe(404);
  });

  it('keeps a change made while acting as the person’s, and audits it (AC-6)', async () => {
    const { owner, member, memberId } = await scene();
    await owner('POST', `/api/v1/people/${memberId}/act-as`, {
      reason: REASON,
    });
    const saved = await owner('PUT', '/api/v1/settings', {
      preferences: { theme: 'esoteric' },
    });
    expect(saved.statusCode).toBe(200);
    await owner('DELETE', '/api/v1/act-as');
    expect(
      (await member('GET', '/api/v1/settings')).json().preferences.theme,
    ).toBe('esoteric');
    const audit = (await owner('GET', '/api/v1/act-as/audit')).json().items;
    expect(audit.map((e: { kind: string }) => e.kind)).toEqual([
      'end',
      'write',
      'start',
    ]);
    expect(audit[1]).toMatchObject({
      method: 'PUT',
      route: '/api/v1/settings',
      reason: REASON,
      actor: { email: OWNER_EMAIL },
      person: { email: 'ana@example.com' },
    });
    expect(audit[0]).toMatchObject({ endedBy: 'actor' });
  });

  it('never acts as the owner or a master, nor lets a master without the grant (AC-3, AC-4)', async () => {
    const { owner, memberId, master, masterId } = await scene();
    const ownerId = (await owner('GET', '/api/v1/people'))
      .json()
      .items.find((p: { isOwner: boolean }) => p.isOwner).id;
    expect(
      (
        await owner('POST', `/api/v1/people/${masterId}/act-as`, {
          reason: REASON,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await owner('POST', `/api/v1/people/${ownerId}/act-as`, {
          reason: REASON,
        })
      ).statusCode,
    ).toBe(403);
    // Bruno is a master, but the owner did not grant it to him.
    expect((await master('GET', '/api/v1/me')).json().canActAs).toBe(false);
    expect(
      (
        await master('POST', `/api/v1/people/${memberId}/act-as`, {
          reason: REASON,
        })
      ).statusCode,
    ).toBe(403);
    expect((await master('GET', '/api/v1/act-as/audit')).statusCode).toBe(403);
    // Only the owner grants it; once granted, Bruno may.
    expect(
      (await master('PATCH', `/api/v1/people/${masterId}`, { canActAs: true }))
        .statusCode,
    ).toBe(403);
    const granted = await owner('PATCH', `/api/v1/people/${masterId}`, {
      canActAs: true,
    });
    expect(granted.json().canActAs).toBe(true);
    expect(
      (
        await master('POST', `/api/v1/people/${memberId}/act-as`, {
          reason: REASON,
        })
      ).statusCode,
    ).toBe(200);
    // Losing the master role takes the grant away.
    await owner('PATCH', `/api/v1/people/${masterId}`, { role: 'member' });
    const demoted = (await owner('GET', '/api/v1/people'))
      .json()
      .items.find((p: { id: string }) => p.id === masterId);
    expect(demoted.canActAs).toBe(false);
  });

  it('refuses what only the person may do, and changes nothing (AC-5)', async () => {
    const { owner, memberId } = await scene();
    await owner('POST', `/api/v1/people/${memberId}/act-as`, {
      reason: REASON,
    });
    const refused = [
      await owner('PUT', '/api/v1/settings', {
        ai: { keys: { openrouter: 'sk-or-fake-key-for-test' } },
      }),
      await owner('POST', '/api/v1/settings/ai/test', {
        provider: 'openrouter',
        key: 'sk-or-fake-key-for-test',
      }),
      await owner('POST', '/api/v1/openrouter/connect', { purpose: 'own' }),
    ];
    for (const response of refused) {
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('NOT_WHILE_ACTING');
    }
    // "Sair" only brings the owner back, it does not sign them out.
    expect((await owner('POST', '/api/v1/auth/logout')).statusCode).toBe(204);
    expect((await owner('GET', '/api/v1/me')).json()).toMatchObject({
      email: OWNER_EMAIL,
      actingAs: null,
    });
  });

  it('ends after 30 minutes, back to the master’s own view (AC-7)', async () => {
    const { owner, memberId } = await scene();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    await owner('POST', `/api/v1/people/${memberId}/act-as`, {
      reason: REASON,
    });
    vi.setSystemTime(new Date('2026-11-03T12:29:59Z'));
    expect((await owner('GET', '/api/v1/me')).json().email).toBe(
      'ana@example.com',
    );
    vi.setSystemTime(new Date('2026-11-03T12:30:00Z'));
    expect((await owner('GET', '/api/v1/me')).json()).toMatchObject({
      email: OWNER_EMAIL,
      actingAs: null,
    });
    const audit = (await owner('GET', '/api/v1/act-as/audit')).json().items;
    expect(audit[0]).toMatchObject({ kind: 'end', endedBy: 'timeout' });
  });

  it('ends when the person becomes a master, audited as lost access (BR-5)', async () => {
    const { owner, memberId, master, masterId } = await scene();
    await owner('PATCH', `/api/v1/people/${masterId}`, { canActAs: true });
    await owner('POST', `/api/v1/people/${memberId}/act-as`, {
      reason: REASON,
    });
    // Another master promotes Ana meanwhile: masters cannot be acted as.
    expect(
      (await master('PATCH', `/api/v1/people/${memberId}`, { role: 'master' }))
        .statusCode,
    ).toBe(200);
    // People are re-read from the store at most every 60 s: the owner sees it next.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const me = (await owner('GET', '/api/v1/me')).json();
    expect(me).toMatchObject({ email: OWNER_EMAIL, actingAs: null });
    const audit = (await master('GET', '/api/v1/act-as/audit')).json().items;
    expect(audit[0]).toMatchObject({ kind: 'end', endedBy: 'access' });
  });

  it('refuses research with the person’s own AI, never spending their money (BR-4)', async () => {
    const { owner, member, memberId } = await scene();
    const own = await member('PUT', '/api/v1/settings', {
      ai: {
        provider: 'openrouter',
        keys: { openrouter: 'sk-or-fake-key-for-test' },
      },
    });
    expect(own.statusCode).toBe(200);
    await owner('POST', `/api/v1/people/${memberId}/act-as`, {
      reason: REASON,
    });
    const refused = await owner('POST', '/api/v1/topics/hermetismo/research', {
      question: 'O que é o princípio do ritmo?',
      profile: 'fast',
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('NOT_WHILE_ACTING');
  });

  it('shows the person each time someone acted as them (AC-8)', async () => {
    const { owner, member, memberId } = await scene();
    await owner('POST', `/api/v1/people/${memberId}/act-as`, {
      reason: REASON,
    });
    await owner('PUT', '/api/v1/settings', { preferences: { theme: 'dark' } });
    await owner('DELETE', '/api/v1/act-as');
    await owner('POST', `/api/v1/people/${memberId}/act-as`, {
      reason: 'conferir o tema',
    });
    const accesses = (await member('GET', '/api/v1/me/accesses')).json().items;
    expect(accesses).toHaveLength(2);
    expect(accesses[0]).toMatchObject({
      actorEmail: OWNER_EMAIL,
      reason: 'conferir o tema',
      endedAt: null,
      writes: 0,
    });
    expect(accesses[1]).toMatchObject({ reason: REASON, writes: 1 });
    expect(accesses[1].endedAt).not.toBeNull();
  });

  it('needs a reason (AC-9)', async () => {
    const { owner, memberId } = await scene();
    const empty = await owner('POST', `/api/v1/people/${memberId}/act-as`, {
      reason: '  ',
    });
    expect(empty.statusCode).toBe(400);
    expect((await owner('GET', '/api/v1/me')).json().actingAs).toBeNull();
  });

  it('adds under 20 ms per request while acting (NFR-1)', async () => {
    const { owner, memberId } = await scene();
    const time = async () => {
      const samples: number[] = [];
      for (let i = 0; i < 200; i++) {
        const t = performance.now();
        await owner('GET', '/api/v1/me');
        samples.push(performance.now() - t);
      }
      samples.sort((a, b) => a - b);
      return samples[Math.floor(samples.length * 0.95)] ?? 0;
    };
    const own = await time();
    await owner('POST', `/api/v1/people/${memberId}/act-as`, {
      reason: REASON,
    });
    const acting = await time();
    expect(acting - own).toBeLessThan(20);
  });

  it('refuses every action that is only the person’s, route by route (AC-5)', async () => {
    const { owner, memberId } = await scene();
    await owner('POST', `/api/v1/people/${memberId}/act-as`, {
      reason: REASON,
    });
    const ONLY_THE_PERSON: readonly [string, string, object][] = [
      [
        'PUT',
        '/api/v1/settings',
        { ai: { keys: { openrouter: 'sk-or-fake-key-xx' } } },
      ],
      ['PUT', '/api/v1/settings', { ai: { keys: { openrouter: null } } }],
      ['PUT', '/api/v1/settings', { ai: { provider: 'app' } }],
      ['PUT', '/api/v1/settings', { ai: { dailyCapUsd: 5 } }],
      [
        'POST',
        '/api/v1/settings/ai/test',
        { provider: 'openrouter', key: 'sk-or-fake-key-xx' },
      ],
      ['POST', '/api/v1/openrouter/connect', { purpose: 'own' }],
    ];
    for (const [method, url, payload] of ONLY_THE_PERSON) {
      const response = await owner(method as 'PUT' | 'POST', url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(response.json().error.code, `${method} ${url}`).toBe(
        'NOT_WHILE_ACTING',
      );
    }
    const callback = await owner(
      'GET',
      '/api/v1/openrouter/callback?code=x&state=y',
    );
    expect(callback.statusCode).toBe(403);
  });

  it('audits a research made as the person, though it answers by streaming (FR-4)', async () => {
    const { owner, memberId } = await scene();
    await owner('POST', `/api/v1/people/${memberId}/act-as`, {
      reason: REASON,
    });
    await research(owner);
    await owner('DELETE', '/api/v1/act-as');
    const audit = (await owner('GET', '/api/v1/act-as/audit')).json().items;
    expect(audit).toContainEqual(
      expect.objectContaining({
        kind: 'write',
        method: 'POST',
        route: '/api/v1/topics/:topic/research',
      }),
    );
  });

  it('never acts as someone who has not signed in yet: their data would move at sign-in', async () => {
    const { owner } = await scene();
    const invited = await owner('POST', '/api/v1/people', {
      email: 'nunca@example.com',
      sendEmail: false,
    });
    const refused = await owner(
      'POST',
      `/api/v1/people/${invited.json().id}/act-as`,
      { reason: REASON },
    );
    expect(refused.statusCode).toBe(403);
  });

  it('goes back to the master’s own view when the master loses the grant or the person is removed (BR-5)', async () => {
    const { owner, memberId, master, masterId } = await scene();
    await owner('PATCH', `/api/v1/people/${masterId}`, { canActAs: true });
    await master('POST', `/api/v1/people/${memberId}/act-as`, {
      reason: REASON,
    });
    expect((await master('GET', '/api/v1/me')).json().actingAs).not.toBeNull();
    await owner('PATCH', `/api/v1/people/${masterId}`, { canActAs: false });
    expect((await master('GET', '/api/v1/me')).json()).toMatchObject({
      email: 'bruno@example.com',
      actingAs: null,
    });
    await owner('PATCH', `/api/v1/people/${masterId}`, { canActAs: true });
    await master('POST', `/api/v1/people/${memberId}/act-as`, {
      reason: REASON,
    });
    expect(
      (await owner('DELETE', `/api/v1/people/${memberId}`)).statusCode,
    ).toBeLessThan(300);
    expect((await master('GET', '/api/v1/me')).json()).toMatchObject({
      email: 'bruno@example.com',
      actingAs: null,
    });
    const ends = (await owner('GET', '/api/v1/act-as/audit'))
      .json()
      .items.filter((e: { kind: string }) => e.kind === 'end');
    expect(ends.map((e: { endedBy: string }) => e.endedBy)).toEqual([
      'access',
      'access',
    ]);
    // The removed person is still named in the audit as they were.
    expect(ends[0].person.email).toBe('ana@example.com');
  });

  it('shows a session that timed out with no request after as ended, at the 30 minutes (BR-7)', async () => {
    const { owner, member, memberId } = await scene();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    await owner('POST', `/api/v1/people/${memberId}/act-as`, {
      reason: REASON,
    });
    vi.setSystemTime(new Date('2026-11-03T13:00:00Z'));
    const [access] = (await member('GET', '/api/v1/me/accesses')).json().items;
    expect(access).toMatchObject({
      startedAt: '2026-11-03T12:00:00.000Z',
      endedAt: '2026-11-03T12:30:00.000Z',
    });
  });

  it('tells the browser the time left by the server’s clock', async () => {
    const { owner, memberId } = await scene();
    await owner('POST', `/api/v1/people/${memberId}/act-as`, {
      reason: REASON,
    });
    const left = (await owner('GET', '/api/v1/me')).json().actingAs.remainingMs;
    expect(left).toBeGreaterThan(29 * 60_000);
    expect(left).toBeLessThanOrEqual(30 * 60_000);
  });

  it('refuses a write from a tab that still shows another view, and changes nothing (BR-3)', async () => {
    const { started, owner, member, memberId } = await scene();
    const headers = await signIn(started, OWNER_EMAIL);
    const as = (view: string): Call =>
      caller(started.app, { ...headers, 'x-kb-chat-view': view });
    await as('self')('POST', `/api/v1/people/${memberId}/act-as`, {
      reason: REASON,
    });
    // A tab still showing the owner's own view writes: refused, nothing changes.
    const stale = await as('self')('PUT', '/api/v1/settings', {
      preferences: { theme: 'dark' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('VIEW_CHANGED');
    expect(
      (await member('GET', '/api/v1/settings')).json().preferences.theme,
    ).not.toBe('dark');
    // The tab that knows it shows Ana writes as Ana.
    expect(
      (
        await as(memberId)('PUT', '/api/v1/settings', {
          preferences: { theme: 'dark' },
        })
      ).statusCode,
    ).toBe(200);
    await as(memberId)('DELETE', '/api/v1/act-as');
    // Back to self: a tab still showing Ana is refused.
    const old = await as(memberId)('PUT', '/api/v1/settings', {
      preferences: { theme: 'light' },
    });
    expect(old.json().error.code).toBe('VIEW_CHANGED');
    expect(
      (await owner('GET', '/api/v1/settings')).json().preferences.theme,
    ).not.toBe('light');
  });

  it('records a write refused after its audit as refused, not as a change (FR-4)', async () => {
    const { owner, member, memberId } = await scene();
    await owner('POST', `/api/v1/people/${memberId}/act-as`, {
      reason: REASON,
    });
    await owner('PUT', '/api/v1/settings', {
      ai: { keys: { openrouter: 'sk-or-fake-key-xx' } },
    });
    await owner('PUT', '/api/v1/settings', { preferences: { theme: 'dark' } });
    await owner('DELETE', '/api/v1/act-as');
    const kinds = (await owner('GET', '/api/v1/act-as/audit'))
      .json()
      .items.map((e: { kind: string }) => e.kind);
    expect(kinds).toEqual(['end', 'write', 'refused', 'write', 'start']);
    const [access] = (await member('GET', '/api/v1/me/accesses')).json().items;
    expect(access.writes).toBe(1);
  });

  it('declares exactly the routes only the person may use (BR-4)', async () => {
    const { started } = await scene();
    expect([...started.app.personOnlyRoutes].sort()).toEqual([
      'GET /api/v1/openrouter/callback',
      'POST /api/v1/openrouter/connect',
    ]);
  });
});
