import { afterEach, describe, expect, it } from 'vitest';
import {
  OWNER_EMAIL,
  closeApp,
  connectHouse,
  research,
  start,
  statePlain,
  withPeople,
} from '../test/ai-app-harness.js';

afterEach(closeApp);

describe('IA da aplicação: connection (KBC-022 AC-1, AC-2)', () => {
  it('connects the house account with OAuth PKCE and keeps only a sealed key', async () => {
    const started = await start();
    const { owner } = await withPeople(started);
    const { back, state, code } = await connectHouse(started, owner);
    expect(back.statusCode).toBe(303);
    expect(back.headers.location).toBe('/?openrouter=connected&for=house');
    const view = (await owner('GET', '/api/v1/house-ai')).json();
    expect(view.connection).toMatchObject({
      key: { set: true, last4: 'wxyz' },
      via: 'oauth',
      connectedBy: OWNER_EMAIL,
    });
    expect(view.chain).toEqual([
      'fake/large:free',
      'fake/small:free',
      'openrouter/free',
    ]);
    expect(view.freeUsage).toEqual({ used: 0, limit: 1000, remaining: 1000 });
    expect(await statePlain(started.state)).not.toContain('house-oauth');
    expect(started.logs.join('\n')).not.toContain(code);
    // The same state again, a made-up one, or no code: nothing is stored.
    const replay = await owner(
      'GET',
      `/api/v1/openrouter/callback?code=${code}&state=${state}`,
    );
    expect(replay.headers.location).toBe('/?openrouter=error');
    const missing = await owner('GET', '/api/v1/openrouter/callback?state=x');
    expect(missing.headers.location).toBe('/?openrouter=error');
  });

  it('refuses a callback from another session and anything house-related to a member', async () => {
    const started = await start();
    const { owner, member } = await withPeople(started);
    const { authorizeUrl } = (
      await owner('POST', '/api/v1/openrouter/connect', { purpose: 'house' })
    ).json();
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
    const stolen = await member(
      'GET',
      `/api/v1/openrouter/callback?code=abc&state=${state}`,
    );
    expect(stolen.headers.location).toBe('/?openrouter=error');
    expect((await member('GET', '/api/v1/house-ai')).statusCode).toBe(403);
    expect(
      (await member('PUT', '/api/v1/house-ai', { includeRouter: false }))
        .statusCode,
    ).toBe(403);
    expect(
      (await member('POST', '/api/v1/openrouter/connect', { purpose: 'house' }))
        .statusCode,
    ).toBe(403);
    expect((await member('GET', '/api/v1/ai/free-models')).statusCode).toBe(
      200,
    );
  });

  it('accepts a pasted key, tests it, and disconnects', async () => {
    const started = await start();
    const { owner } = await withPeople(started);
    started.fake.acceptKey('sk-or-v1-pasted-1234');
    const view = (
      await owner('PUT', '/api/v1/house-ai', { key: 'sk-or-v1-pasted-1234' })
    ).json();
    expect(view.connection).toMatchObject({
      via: 'key',
      key: { last4: '1234' },
    });
    expect((await owner('POST', '/api/v1/house-ai/test')).json()).toMatchObject(
      {
        ok: true,
      },
    );
    expect((await owner('DELETE', '/api/v1/house-ai/key')).statusCode).toBe(
      204,
    );
    expect((await owner('POST', '/api/v1/house-ai/test')).json()).toMatchObject(
      {
        ok: false,
        code: 'LLM_NOT_CONFIGURED',
      },
    );
  });
});

describe('IA da aplicação: research on the house plan (KBC-022 AC-4 to AC-6)', () => {
  it('answers a person with no AI of their own, free, naming the model and the quota left', async () => {
    const started = await start();
    const { owner, member } = await withPeople(started);
    await connectHouse(started, owner);
    const turn = await research(member);
    expect(turn.at(-1)).toMatchObject({
      type: 'done',
      model: 'fake/large:free',
      billing: 'free',
      plan: 'house',
      remaining: 4,
      usd: 0,
    });
    expect(started.fake.chats[0]?.models).toEqual([
      'fake/large:free',
      'fake/small:free',
      'openrouter/free',
    ]);
    expect((await member('GET', '/api/v1/ai/status')).json()).toEqual({
      source: 'app',
      appAi: 'house',
      provider: 'app',
      remainingToday: 4,
      dailyResearches: 5,
      enforced: false,
      spentTodayUsd: null,
      dailyCapUsd: null,
      free: true,
      lastTest: null,
    });
  });

  it('refuses past the person’s daily quota (deep counts 2)', async () => {
    const started = await start();
    const { owner, member, memberId } = await withPeople(started);
    await connectHouse(started, owner);
    await owner('PATCH', `/api/v1/people/${memberId}`, {
      ai: { dailyResearches: 2 },
    });
    expect((await research(member, 'deep')).at(-1)).toMatchObject({
      type: 'done',
      remaining: 0,
    });
    expect(await research(member, 'fast')).toContainEqual({
      type: 'error',
      code: 'HOUSE_QUOTA_EXHAUSTED',
      limit: 2,
    });
  });

  it('refuses when the free capacity of the day is short, without spending the quota', async () => {
    const started = await start();
    const { owner, member } = await withPeople(started);
    await connectHouse(started, owner);
    started.fake.freeRemaining = 5;
    expect(await research(member, 'deep')).toContainEqual({
      type: 'error',
      code: 'AI_CAPACITY_EXHAUSTED',
    });
    expect((await member('GET', '/api/v1/ai/status')).json()).toMatchObject({
      remainingToday: 5,
    });
  });

  it('gives the quota back when every free model is busy before answering', async () => {
    const started = await start();
    const { owner, member } = await withPeople(started);
    await connectHouse(started, owner);
    for (const id of ['fake/large:free', 'fake/small:free', 'openrouter/free'])
      started.fake.busy.add(id);
    expect(await research(member)).toContainEqual({
      type: 'error',
      code: 'AI_CAPACITY_EXHAUSTED',
    });
    expect((await member('GET', '/api/v1/ai/status')).json()).toMatchObject({
      remainingToday: 5,
    });
  });
});

describe('The AI access policy (KBC-022 AC-8, AC-12, AC-13)', () => {
  it('assigns the app AI to some people, then to everyone and as the default, with an audit trail', async () => {
    const started = await start();
    const { owner, member, memberId } = await withPeople(started);
    await connectHouse(started, owner);
    const assigned = await owner('POST', '/api/v1/people/ai-assignment', {
      personIds: [memberId],
      appAi: 'house',
    });
    expect(assigned.json()).toEqual({ updated: 1 });
    const all = await owner('POST', '/api/v1/people/ai-assignment', {
      personIds: 'all',
      appAi: 'none',
      setDefault: true,
    });
    expect(all.json()).toEqual({ updated: 2 });
    const people = (await owner('GET', '/api/v1/people')).json().items;
    const ana = people.find((p: { id: string }) => p.id === memberId);
    expect(ana.ai.appAi).toBe('none');
    expect(
      ana.ai.history.map((h: { appAi: string; by: string }) => [h.appAi, h.by]),
    ).toEqual([
      ['house', OWNER_EMAIL],
      ['none', OWNER_EMAIL],
    ]);
    expect((await owner('GET', '/api/v1/house-ai')).json().defaultAppAi).toBe(
      'none',
    );
    expect((await member('GET', '/api/v1/ai/status')).json().source).toBe(
      'none',
    );
    // QA defect 1/3: a partial list or an unknown id never changes the default.
    const partial = await owner('POST', '/api/v1/people/ai-assignment', {
      personIds: [memberId, '00000000-0000-4000-8000-000000000000'],
      appAi: 'house',
      setDefault: true,
    });
    expect(partial.statusCode).toBe(400);
    const unknown = await owner('POST', '/api/v1/people/ai-assignment', {
      personIds: [memberId, '00000000-0000-4000-8000-000000000000'],
      appAi: 'house',
    });
    expect(unknown.statusCode).toBe(404);
    expect((await owner('GET', '/api/v1/house-ai/default')).json()).toEqual({
      defaultAppAi: 'none',
      subscriptionAvailable: false,
    });
    expect(
      (await owner('GET', '/api/v1/house-ai')).json().defaultChange,
    ).toMatchObject({
      by: OWNER_EMAIL,
    });
    const bad = await owner('POST', '/api/v1/people/ai-assignment', {
      personIds: 'all',
      appAi: 'default',
      setDefault: true,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('lets a person’s own AI win unless the master enforces the app AI', async () => {
    const started = await start();
    const { owner, member, memberId } = await withPeople(started);
    await connectHouse(started, owner);
    started.fake.acceptKey('sk-or-v1-ana-own-5678');
    await member('PUT', '/api/v1/settings', {
      ai: {
        provider: 'openrouter',
        keys: { openrouter: 'sk-or-v1-ana-own-5678' },
        // A model the fake OpenRouter lists (it prices from its own list).
        models: { openrouter: { fast: 'fake/paid' } },
      },
    });
    expect((await member('GET', '/api/v1/ai/status')).json()).toMatchObject({
      source: 'own',
      provider: 'openrouter',
    });
    expect((await research(member)).at(-1)).toMatchObject({
      type: 'done',
      plan: 'own',
    });
    await owner('PATCH', `/api/v1/people/${memberId}`, {
      ai: { enforced: true },
    });
    expect((await member('GET', '/api/v1/ai/status')).json()).toMatchObject({
      source: 'app',
      appAi: 'house',
      enforced: true,
    });
    // The person's key is sealed on disk and never in a response or the log.
    const everything = [
      await statePlain(started.state),
      (await member('GET', '/api/v1/settings')).body,
      (await member('GET', '/api/v1/ai/providers')).body,
      started.logs.join('\n'),
    ].join('\n');
    expect(everything).not.toContain('ana-own');
  });

  it('keeps a person’s OpenRouter key limit in step with their paid fallback', async () => {
    const started = await start();
    const { owner, memberId } = await withPeople(started);
    await connectHouse(started, owner);
    const unknown = await owner('PUT', '/api/v1/house-ai', {
      paidModel: 'fake/typo',
    });
    expect(unknown.statusCode).toBe(400);
    await owner('PUT', '/api/v1/house-ai', {
      paidModel: 'fake/paid',
      managementKey: 'sk-or-v1-mgmt-0001',
    });
    const enable = await owner('PATCH', `/api/v1/people/${memberId}`, {
      ai: { paidFallback: { enabled: true, monthlyCapUsd: 2 } },
    });
    expect(enable.statusCode).toBe(200);
    expect([...started.fake.createdKeys.values()].map((k) => k.limit)).toEqual([
      2,
    ]);
    await owner('PATCH', `/api/v1/people/${memberId}`, {
      ai: { paidFallback: { enabled: true, monthlyCapUsd: 3 } },
    });
    expect([...started.fake.createdKeys.values()].map((k) => k.limit)).toEqual([
      3,
    ]);
    await owner('PATCH', `/api/v1/people/${memberId}`, {
      ai: { paidFallback: { enabled: false, monthlyCapUsd: 3 } },
    });
    expect(started.fake.createdKeys.size).toBe(0);
    expect(await statePlain(started.state)).not.toContain('mgmt-0001');
    // OpenRouter fails: the change is refused and the person keeps the fallback off.
    started.fake.failManagement = true;
    const refused = await owner('PATCH', `/api/v1/people/${memberId}`, {
      ai: { paidFallback: { enabled: true, monthlyCapUsd: 3 } },
    });
    expect(refused.statusCode).toBe(503);
    const people = (await owner('GET', '/api/v1/people')).json().items;
    const ana = people.find((p: { id: string }) => p.id === memberId);
    expect(ana.ai.paidFallback.enabled).toBe(false);
  });
});
