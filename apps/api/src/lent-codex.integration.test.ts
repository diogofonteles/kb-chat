import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeApp,
  codexRunnerCounts,
  research,
  start,
  stopCodexRunner,
  withPeople,
} from '../test/ai-app-harness.js';

afterEach(async () => {
  vi.useRealTimers();
  await closeApp();
});

const LEND = {
  appAi: 'chatgpt-subscription',
  subscriptionTermsAccepted: true,
} as const;

/** The app with Codex behind its sandbox runner, the fake Codex reporting what it saw. */
async function withCodex() {
  const codexHome = await mkdtemp(join(tmpdir(), 'kbchat-codex-home-'));
  const report = join(codexHome, 'report.json');
  await writeFile(join(codexHome, 'fake-cli.json'), JSON.stringify({ report }));
  const started = await start({ codexHome });
  const people = await withPeople(started);
  const seen = async () => JSON.parse(await readFile(report, 'utf8'));
  return { started, ...people, codexHome, seen };
}

describe('Codex, the ChatGPT subscription, in its sandbox (KBC-027)', () => {
  it('stays off until a master turns it on, then answers the owner through the runner (AC-2, AC-4)', async () => {
    const { owner, codexHome, seen } = await withCodex();
    const before = (await owner('GET', '/api/v1/house-ai')).json();
    expect(before.codex).toEqual({
      configured: true,
      enabled: false,
      loggedIn: true,
    });
    expect(before.lendable['chatgpt-subscription']).toBe(false);
    await owner('PUT', '/api/v1/settings', {
      ai: { provider: 'chatgpt-subscription' },
    });
    const providers = (await owner('GET', '/api/v1/ai/providers')).json();
    expect(
      providers.items.find(
        (item: { id: string }) => item.id === 'chatgpt-subscription',
      ),
    ).toMatchObject({ available: false, reason: 'not-enabled' });
    const on = await owner('PUT', '/api/v1/house-ai', { codexEnabled: true });
    expect(on.json().codex).toEqual({
      configured: true,
      enabled: true,
      loggedIn: true,
    });
    expect(on.json().lendable['chatgpt-subscription']).toBe(true);
    const done = (await research(owner)).at(-1);
    expect(done).toMatchObject({
      type: 'done',
      billing: 'subscription',
      usd: 0,
    });
    const { codexHome: home, envNames } = await seen();
    expect(home).toBe(codexHome);
    expect(envNames).not.toContain('KB_CHAT_SECRETS_KEY');
    expect(
      (envNames as string[]).filter((name) => !name.startsWith('__CF_')).sort(),
    ).toEqual(['CODEX_HOME', 'HOME', 'KB_CHAT_MCP_TOKEN', 'PATH']);
  });

  it('is lent like the first subscription: owner only, after the terms, on the quota (AC-5)', async () => {
    const { owner, member, memberId } = await withCodex();
    await owner('PUT', '/api/v1/house-ai', { codexEnabled: true });
    const url = `/api/v1/people/${memberId}`;
    expect(
      (await owner('PATCH', url, { ai: { appAi: 'chatgpt-subscription' } }))
        .statusCode,
    ).toBe(400);
    const lent = await owner('PATCH', url, { ai: LEND });
    expect(lent.json().ai.history.at(-1)).toMatchObject({
      appAi: 'chatgpt-subscription',
      termsAccepted: true,
    });
    expect((await member('GET', '/api/v1/ai/status')).json()).toMatchObject({
      source: 'app',
      appAi: 'chatgpt-subscription',
    });
    expect((await research(member)).at(-1)).toMatchObject({
      type: 'done',
      billing: 'subscription',
      plan: 'app-chatgpt-subscription',
      remaining: 4,
    });
    // Turned off by a master: nobody is served by it any more (AC-4).
    await owner('PUT', '/api/v1/house-ai', { codexEnabled: false });
    expect((await member('GET', '/api/v1/ai/status')).json().source).toBe(
      'none',
    );
  });

  it('never makes it the default', async () => {
    const { owner } = await withCodex();
    expect(
      (
        await owner('PUT', '/api/v1/house-ai', {
          defaultAppAi: 'chatgpt-subscription',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('stops serving the owner too once a master turns it off (review R1)', async () => {
    const { owner } = await withCodex();
    await owner('PUT', '/api/v1/house-ai', { codexEnabled: true });
    await owner('PUT', '/api/v1/settings', {
      ai: { provider: 'chatgpt-subscription' },
    });
    expect((await research(owner)).at(-1)).toMatchObject({ type: 'done' });
    await owner('PUT', '/api/v1/house-ai', { codexEnabled: false });
    // Refused before any answer (the route says no AI is configured for him).
    const after = await research(owner);
    expect(after.some((event) => event.type === 'done')).toBe(false);
  });

  it('lets lent people fall back while its container is down (review R2)', async () => {
    const { owner, member, memberId } = await withCodex();
    await owner('PUT', '/api/v1/house-ai', { codexEnabled: true });
    await owner('PATCH', `/api/v1/people/${memberId}`, { ai: LEND });
    await stopCodexRunner();
    expect((await research(member)).at(-1)).toMatchObject({
      type: 'error',
      code: 'CLI_MISSING',
    });
    expect((await member('GET', '/api/v1/ai/status')).json().source).toBe(
      'none',
    );
    const house = (await owner('GET', '/api/v1/house-ai')).json();
    expect(house.lendable['chatgpt-subscription']).toBe(false);
    expect(house.codex.loggedIn).toBeNull();
  });

  it('answers nothing but MCP to the Codex sandbox’s address (review F3)', async () => {
    const started = await start();
    const { owner } = await withPeople(started);
    const fromCodex = (url: string, method: 'GET' | 'POST' = 'GET') =>
      started.app.inject({
        method,
        url,
        remoteAddress: '172.30.0.10',
        headers: { host: 'localhost:3000', 'x-requested-with': 'kb-chat' },
      });
    expect((await fromCodex('/api/v1/topics')).statusCode).toBe(404);
    expect((await fromCodex('/health')).statusCode).toBe(404);
    expect((await fromCodex('/api/v1/auth/code', 'POST')).statusCode).toBe(404);
    // An unknown turn token is a 404 too, but from the MCP route itself.
    expect((await fromCodex('/mcp/turn', 'POST')).statusCode).toBe(404);
    // Everyone else is unaffected.
    expect((await owner('GET', '/api/v1/topics')).statusCode).toBe(200);
  });

  it('pauses lending only when the sandbox is down, not on a failed turn (review 2.1)', async () => {
    const { owner, member, memberId, codexHome } = await withCodex();
    await owner('PUT', '/api/v1/house-ai', { codexEnabled: true });
    await owner('PATCH', `/api/v1/people/${memberId}`, { ai: LEND });
    await writeFile(
      join(codexHome, 'fake-cli.json'),
      JSON.stringify({ mode: 'error' }),
    );
    expect((await research(member)).at(-1)).toMatchObject({
      type: 'error',
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect((await member('GET', '/api/v1/ai/status')).json().source).toBe(
      'app',
    );
  });

  it('asks the sandbox about the login at most every 30 s (review 2.2)', async () => {
    const { owner } = await withCodex();
    const checks = () => codexRunnerCounts().statusChecks;
    await owner('GET', '/api/v1/house-ai');
    await owner('GET', '/api/v1/house-ai');
    expect(checks()).toBe(1);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31_000);
    await owner('GET', '/api/v1/house-ai');
    expect(checks()).toBe(2);
  });

  it('is not lendable while Codex is logged out on the server (QA N-2)', async () => {
    const { owner, codexHome } = await withCodex();
    await owner('PUT', '/api/v1/house-ai', { codexEnabled: true });
    await writeFile(
      join(codexHome, 'fake-cli.json'),
      JSON.stringify({ mode: 'fail' }),
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31_000);
    const house = (await owner('GET', '/api/v1/house-ai')).json();
    expect(house.codex.loggedIn).toBe(false);
    expect(house.lendable['chatgpt-subscription']).toBe(false);
  });
});
