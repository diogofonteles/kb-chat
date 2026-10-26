import { afterEach, describe, expect, it } from 'vitest';
import {
  closeApp,
  research,
  start,
  statePlain,
  withPeople,
  type Call,
  type Started,
} from '../test/ai-app-harness.js';

afterEach(closeApp);

/** Connects the member's own OpenRouter through OAuth PKCE against the fake. */
async function connectOwn(started: Started, member: Call) {
  const started_ = await member('POST', '/api/v1/openrouter/connect', {
    purpose: 'own',
  });
  expect(started_.statusCode).toBe(200);
  const url = new URL(started_.json().authorizeUrl);
  const code = started.fake.authorize(
    url.searchParams.get('code_challenge') ?? '',
    'sk-or-v1-ana-own-oauth-abcd',
  );
  return member(
    'GET',
    `/api/v1/openrouter/callback?code=${code}&state=${url.searchParams.get('state')}`,
  );
}

describe('Sua IA: OpenRouter by OAuth on free models (KBC-023 AC-1, AC-2)', () => {
  it('connects one’s own account, chooses it on free models and answers for free', async () => {
    const started = await start();
    const { member } = await withPeople(started);
    const back = await connectOwn(started, member);
    expect(back.headers.location).toBe('/?openrouter=connected&for=own');
    const settings = (await member('GET', '/api/v1/settings')).json();
    expect(settings.ai).toMatchObject({
      provider: 'openrouter',
      keys: { openrouter: { set: true, last4: 'abcd' } },
      openrouter: { mode: 'free', freeModels: null, paidModel: null },
    });
    expect(await statePlain(started.state)).not.toContain('own-oauth');
    const done = (await research(member)).at(-1);
    expect(done).toMatchObject({
      type: 'done',
      plan: 'own',
      billing: 'free',
      model: 'fake/large:free',
    });
    expect(started.fake.chats.at(-1)?.models).toEqual([
      'fake/large:free',
      'fake/small:free',
      'openrouter/free',
    ]);
    expect(started.fake.chats.at(-1)?.authorization).toBe(
      'Bearer sk-or-v1-ana-own-oauth-abcd',
    );
    expect((await member('GET', '/api/v1/ai/status')).json()).toMatchObject({
      source: 'own',
      provider: 'openrouter',
      free: true,
      spentTodayUsd: null,
    });
  });

  it('refuses the connection to someone without "Configurações de IA próprias"', async () => {
    const started = await start();
    const { owner, memberId, member } = await withPeople(started);
    await owner('PATCH', `/api/v1/people/${memberId}`, {
      features: ['search', 'research'],
    });
    const refused = await member('POST', '/api/v1/openrouter/connect', {
      purpose: 'own',
    });
    expect(refused.statusCode).toBe(403);
  });

  it('adds a paid model only within the daily cap, and charges it', async () => {
    const started = await start();
    const { member } = await withPeople(started);
    await connectOwn(started, member);
    await member('PUT', '/api/v1/settings', {
      ai: { openrouter: { paidModel: 'fake/paid' }, dailyCapUsd: 1 },
    });
    // Every free model is busy: the paid one answers, within the cap.
    for (const id of ['fake/large:free', 'fake/small:free', 'openrouter/free'])
      started.fake.busy.add(id);
    const paid = (await research(member)).at(-1);
    expect(paid).toMatchObject({
      type: 'done',
      billing: 'per-token',
      model: 'fake/paid',
    });
    expect(started.fake.chats.at(-1)?.models).toContain('fake/paid');
    const status = (await member('GET', '/api/v1/ai/status')).json();
    expect(status).toMatchObject({ free: false, dailyCapUsd: 1 });
    expect(status.spentTodayUsd).toBeGreaterThan(0);
    // The cap is spent: the paid model stays out, and the free ones are busy.
    await member('PUT', '/api/v1/settings', { ai: { dailyCapUsd: 0 } });
    const refused = await research(member);
    expect(started.fake.chats.at(-1)?.models).not.toContain('fake/paid');
    expect(refused).toContainEqual({
      type: 'error',
      code: 'AI_CAPACITY_EXHAUSTED',
    });
  });
});

describe('Sua IA: Gemini (KBC-023 AC-4, AC-7)', () => {
  it('tests a key, keeps the outcome and researches on the free tier', async () => {
    const started = await start();
    const { member } = await withPeople(started);
    const refused = await member('POST', '/api/v1/settings/ai/test', {
      provider: 'gemini',
      key: 'AIza-wrong-key',
    });
    expect(refused.json()).toMatchObject({
      ok: false,
      code: 'LLM_KEY_REJECTED',
    });
    await member('PUT', '/api/v1/settings', {
      ai: { provider: 'gemini', keys: { gemini: 'AIza-ana-key-valid' } },
    });
    const ok = await member('POST', '/api/v1/settings/ai/test', {
      provider: 'gemini',
    });
    expect(ok.json()).toMatchObject({
      ok: true,
      model: 'gemini-3.5-flash-lite',
    });
    const status = (await member('GET', '/api/v1/ai/status')).json();
    expect(status).toMatchObject({
      source: 'own',
      provider: 'gemini',
      free: true,
      lastTest: { provider: 'gemini', ok: true, code: null },
    });
    const done = (await research(member)).at(-1);
    expect(done).toMatchObject({
      type: 'done',
      plan: 'own',
      billing: 'free',
      usd: 0,
    });
    expect(started.gemini.calls.at(-1)?.model).toBe('gemini-3.5-flash-lite');
    // The research tools went to Gemini as function declarations.
    expect(JSON.stringify(started.gemini.calls.at(-1)?.body)).toContain(
      'functionDeclarations',
    );
    expect(await statePlain(started.state)).not.toContain('ana-key-valid');
    // A spend over the cap (an earlier paid AI) never blocks the free tier (review m1).
    await member('PUT', '/api/v1/settings', { ai: { dailyCapUsd: 0 } });
    await started.ledger.append({
      ts: new Date().toISOString(),
      principal: 'sub-ana@example.com',
      model: 'paid',
      inputTokens: 1,
      outputTokens: 1,
      usd: 0.5,
      interrupted: false,
    });
    expect((await research(member)).at(-1)).toMatchObject({ type: 'done' });
    // The last test is shown only for the AI serving now (review M2).
    await member('PUT', '/api/v1/settings', { ai: { provider: 'none' } });
    expect(
      (await member('GET', '/api/v1/ai/status')).json().lastTest,
    ).toBeNull();
  });

  it('prices the paid tier and shows today’s spend against the cap', async () => {
    const started = await start();
    const { member } = await withPeople(started);
    await member('PUT', '/api/v1/settings', {
      ai: {
        provider: 'gemini',
        keys: { gemini: 'AIza-ana-key-valid' },
        gemini: { tier: 'paid' },
      },
    });
    const done = (await research(member)).at(-1);
    expect(done).toMatchObject({ type: 'done', billing: 'per-token' });
    const status = (await member('GET', '/api/v1/ai/status')).json();
    expect(status.free).toBe(false);
    expect(status.spentTodayUsd).toBeGreaterThan(0);
    expect(status.dailyCapUsd).toBe(1);
  });
});

describe('Back to the app’s AI (KBC-023 AC-8)', () => {
  it('serves the house plan again once the person picks "IA da aplicação"', async () => {
    const started = await start();
    const { owner, member } = await withPeople(started);
    started.fake.acceptKey('sk-or-v1-house-valid');
    await owner('PUT', '/api/v1/house-ai', { key: 'sk-or-v1-house-valid' });
    await member('PUT', '/api/v1/settings', {
      ai: { provider: 'gemini', keys: { gemini: 'AIza-ana-key-valid' } },
    });
    expect((await member('GET', '/api/v1/ai/status')).json().source).toBe(
      'own',
    );
    await member('PUT', '/api/v1/settings', { ai: { provider: 'app' } });
    expect((await member('GET', '/api/v1/ai/status')).json()).toMatchObject({
      source: 'app',
      appAi: 'house',
    });
    expect((await research(member)).at(-1)).toMatchObject({ plan: 'house' });
  });
});
