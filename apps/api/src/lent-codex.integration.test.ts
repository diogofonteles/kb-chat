import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeApp,
  research,
  start,
  withPeople,
} from '../test/ai-app-harness.js';

afterEach(closeApp);

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
});
