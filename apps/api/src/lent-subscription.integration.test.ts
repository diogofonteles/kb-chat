import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  caller,
  closeApp,
  research,
  signIn,
  start,
  withPeople,
  type Started,
} from '../test/ai-app-harness.js';

afterEach(closeApp);

const LEND = {
  appAi: 'claude-subscription',
  subscriptionTermsAccepted: true,
} as const;

/** A second master besides the owner. */
async function anotherMaster(
  started: Started,
  owner: ReturnType<typeof caller>,
) {
  const invited = await owner('POST', '/api/v1/people', {
    email: 'bea@example.com',
  });
  await owner('PATCH', `/api/v1/people/${invited.json().id}`, {
    role: 'master',
  });
  return caller(started.app, await signIn(started, 'bea@example.com'));
}

const houseSpend = (state: string) =>
  readFile(join(state, 'house-spend.jsonl'), 'utf8').catch(() => '');

describe('Lending the owner’s subscription (KBC-024 AC-1, AC-4)', () => {
  it('lets only the owner lend it, after the terms, and records who and when', async () => {
    const started = await start();
    const { owner, memberId } = await withPeople(started);
    const url = `/api/v1/people/${memberId}`;
    // Without the confirmation of the terms the contract refuses it.
    const unconfirmed = await owner('PATCH', url, {
      ai: { appAi: 'claude-subscription' },
    });
    expect(unconfirmed.statusCode).toBe(400);
    const bea = await anotherMaster(started, owner);
    expect((await bea('PATCH', url, { ai: LEND })).statusCode).toBe(403);
    expect(
      (
        await bea('POST', '/api/v1/people/ai-assignment', {
          personIds: [memberId],
          ...LEND,
        })
      ).statusCode,
    ).toBe(403);
    const lent = await owner('PATCH', url, { ai: LEND });
    expect(lent.statusCode).toBe(200);
    expect(lent.json().ai.appAi).toBe('claude-subscription');
    expect(lent.json().ai.history.at(-1)).toMatchObject({
      appAi: 'claude-subscription',
      by: 'owner@example.com',
      termsAccepted: true,
    });
    // Any master may take it back.
    const revoked = await bea('PATCH', url, { ai: { appAi: 'house' } });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().ai.history.at(-1)).toMatchObject({
      appAi: 'house',
      by: 'bea@example.com',
    });
  });

  it('never makes the subscription the default', async () => {
    const started = await start();
    const { owner } = await withPeople(started);
    const asDefault = await owner('PUT', '/api/v1/house-ai', {
      defaultAppAi: 'claude-subscription',
    });
    expect(asDefault.statusCode).toBe(400);
    const forNextOnes = await owner('POST', '/api/v1/people/ai-assignment', {
      personIds: 'all',
      ...LEND,
      setDefault: true,
    });
    expect(forNextOnes.statusCode).toBe(400);
    const toAll = await owner('POST', '/api/v1/people/ai-assignment', {
      personIds: 'all',
      ...LEND,
    });
    expect(toAll.statusCode).toBe(200);
    const house = (await owner('GET', '/api/v1/house-ai')).json();
    expect(house.defaultAppAi).toBe('house');
  });
});

describe('Researching on the lent subscription (KBC-024 AC-2, AC-3, AC-7)', () => {
  it('answers through the owner’s CLI, counts the quota and records US$ 0', async () => {
    const started = await start({ claude: true });
    const { owner, member, memberId } = await withPeople(started);
    expect(
      (await owner('GET', '/api/v1/house-ai')).json().subscriptionAvailable,
    ).toBe(true);
    await owner('PATCH', `/api/v1/people/${memberId}`, { ai: LEND });
    expect((await member('GET', '/api/v1/ai/status')).json()).toMatchObject({
      source: 'app',
      appAi: 'claude-subscription',
      free: true,
    });
    const stream = await research(member);
    expect(stream.find((event) => event.type === 'sources')).toBeDefined();
    expect(stream.at(-1)).toMatchObject({
      type: 'done',
      usd: 0,
      billing: 'subscription',
      plan: 'app-subscription',
      remaining: 4,
    });
    const entries = (await houseSpend(started.state))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(entries).toEqual([
      expect.objectContaining({
        principal: 'sub-ana@example.com',
        usd: 0,
        billing: 'subscription',
      }),
    ]);
  });

  it('refuses a turn over the daily quota without starting the CLI', async () => {
    const started = await start({ claude: true });
    const { owner, member, memberId } = await withPeople(started);
    const report = join(started.state, 'cli-report.json');
    await writeFile(
      join(started.state, 'fake-cli.json'),
      JSON.stringify({ report }),
    );
    await owner('PATCH', `/api/v1/people/${memberId}`, {
      ai: { ...LEND, dailyResearches: 0 },
    });
    expect((await research(member)).at(-1)).toMatchObject({
      type: 'error',
      code: 'HOUSE_QUOTA_EXHAUSTED',
      limit: 0,
    });
    await expect(readFile(report, 'utf8')).rejects.toThrow();
  });

  it('serves nobody through it while the CLI is missing', async () => {
    const started = await start();
    const { owner, member, memberId } = await withPeople(started);
    expect(
      (await owner('GET', '/api/v1/house-ai')).json().subscriptionAvailable,
    ).toBe(false);
    await owner('PATCH', `/api/v1/people/${memberId}`, { ai: LEND });
    expect((await member('GET', '/api/v1/ai/status')).json().source).toBe(
      'none',
    );
  });

  it('runs the owner’s fast model with no escalation (review R3)', async () => {
    const started = await start({ claude: true });
    const { owner, member, memberId } = await withPeople(started);
    const report = join(started.state, 'cli-report.json');
    await writeFile(
      join(started.state, 'fake-cli.json'),
      JSON.stringify({ report, mode: 'deepen' }),
    );
    await owner('PUT', '/api/v1/settings', {
      ai: {
        models: { 'claude-subscription': { fast: 'haiku', deep: 'opus' } },
      },
    });
    await owner('PATCH', `/api/v1/people/${memberId}`, { ai: LEND });
    const done = (await research(member)).at(-1);
    expect(done).toMatchObject({ type: 'done', plan: 'app-subscription' });
    expect(done?.type === 'done' && done.escalated).toBeFalsy();
    const { args } = JSON.parse(await readFile(report, 'utf8'));
    expect(args).toContain('--model=haiku');
  });

  it('refunds a turn the logged-out CLI could not answer, then serves nobody through it (A2)', async () => {
    const started = await start({ claude: true });
    const { owner, member, memberId } = await withPeople(started);
    await writeFile(
      join(started.state, 'fake-cli.json'),
      JSON.stringify({ mode: 'login' }),
    );
    await owner('PATCH', `/api/v1/people/${memberId}`, { ai: LEND });
    expect((await research(member)).at(-1)).toMatchObject({
      type: 'error',
      code: 'CLI_LOGIN_REQUIRED',
    });
    const status = (await member('GET', '/api/v1/ai/status')).json();
    expect(status.source).toBe('none');
    expect(
      (await owner('GET', '/api/v1/house-ai/default')).json()
        .subscriptionAvailable,
    ).toBe(false);
    // The failed turn gave the research back.
    await owner('PATCH', `/api/v1/people/${memberId}`, {
      ai: { appAi: 'house' },
    });
    started.fake.acceptKey('sk-or-v1-house-valid');
    await owner('PUT', '/api/v1/house-ai', { key: 'sk-or-v1-house-valid' });
    expect(
      (await member('GET', '/api/v1/ai/status')).json().remainingToday,
    ).toBe(5);
  });
});

describe('What only the owner changes on a lent person (KBC-024 F-4)', () => {
  it('refuses another master raising the quota or enforcing it, but lets them revoke', async () => {
    const started = await start();
    const { owner, memberId } = await withPeople(started);
    const url = `/api/v1/people/${memberId}`;
    await owner('PATCH', url, { ai: LEND });
    const bea = await anotherMaster(started, owner);
    expect(
      (await bea('PATCH', url, { ai: { dailyResearches: 50 } })).statusCode,
    ).toBe(403);
    expect(
      (await bea('PATCH', url, { ai: { enforced: true } })).statusCode,
    ).toBe(403);
    expect(
      (await owner('PATCH', url, { ai: { dailyResearches: 2 } })).statusCode,
    ).toBe(200);
    expect(
      (await bea('PATCH', url, { ai: { appAi: 'none' } })).statusCode,
    ).toBe(200);
  });

  it('reads a hand-edited subscription default as no AI (F-6)', async () => {
    const started = await start();
    await writeFile(
      join(started.state, 'house-ai.json'),
      JSON.stringify({ version: 1, defaultAppAi: 'claude-subscription' }),
    );
    await closeApp();
    const again = await start({ state: started.state });
    const { owner } = await withPeople(again);
    expect(
      (await owner('GET', '/api/v1/house-ai/default')).json().defaultAppAi,
    ).toBe('none');
  });
});
