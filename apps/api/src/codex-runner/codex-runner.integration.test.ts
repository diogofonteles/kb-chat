import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResearchEvent } from '@kb-chat/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeResearchTools } from '../../test/fake-research-tools.js';
import { FAKES_DIR } from '../../test/fixture-paths.js';
import { CodexCliRunner } from '../adapters/codex-cli-runner.js';
import { McpTurnRegistry } from '../mcp/mcp-turns.js';
import {
  startMcpTurnServer,
  type McpTurnServer,
} from '../mcp/mcp-turn-server.js';
import { MCP_BEARER_PATH } from '../mcp/mcp-routes.js';
import { startCodexRunner, type CodexRunner } from './runner-server.js';

// Every test here runs real Codex processes (node) and waits for them to go: about a second
// alone, several on a busy machine. Its polls give 8 s, which the default 5 s cut short.
vi.setConfig({ testTimeout: 20_000 });

const turns = new McpTurnRegistry();
let mcp: McpTurnServer;
let runner: CodexRunner;
let codexHome: string;

beforeAll(async () => {
  mcp = await startMcpTurnServer(turns, ['127.0.0.1', 'localhost']);
  codexHome = await mkdtemp(join(tmpdir(), 'kbchat-codex-home-'));
  runner = await startCodexRunner({
    bin: join(FAKES_DIR, 'fake-codex.mjs'),
    codexHome,
    mcpUrl: `${mcp.baseUrl}${MCP_BEARER_PATH}`,
    host: '127.0.0.1',
    port: 0,
    env: { PATH: process.env['PATH'] ?? '', LANG: 'C.UTF-8' },
  });
});

afterAll(async () => {
  await runner.close();
  await mcp.close();
});

const fake = (settings: object) =>
  writeFile(join(codexHome, 'fake-cli.json'), JSON.stringify(settings));

/** The API side: a Codex turn sent to the runner, the API's own environment full of secrets. */
const apiRunner = () =>
  new CodexCliRunner({
    bin: 'codex',
    apiBaseUrl: 'http://127.0.0.1:9',
    turns,
    workDir: tmpdir(),
    env: {
      ...process.env,
      KB_CHAT_SECRETS_KEY: 'KBCHAT-CANARY-secrets-key',
      SMTP_PASSWORD: 'KBCHAT-CANARY-smtp',
    },
    tools: () => new FakeResearchTools(),
    runner: { url: runner.url },
  });

async function collect(signal = new AbortController().signal) {
  const events: ResearchEvent[] = [];
  for await (const event of apiRunner().run({
    topic: 'hermetismo',
    question: 'O que é o ritmo?',
    history: [],
    profile: 'fast',
    signal,
  }))
    events.push(event);
  return events;
}

describe('Codex through its sandbox runner (KBC-027 AC-2, ADR 0020)', () => {
  it('runs the turn in the runner with only its own environment, the tools over MCP', async () => {
    const report = join(codexHome, 'report.json');
    await fake({ report });
    const events = await collect();
    expect(events.map((event) => event.type)).toEqual([
      'step',
      'sources',
      'token',
      'done',
    ]);
    const seen = JSON.parse(await readFile(report, 'utf8'));
    expect(seen.codexHome).toBe(codexHome);
    // A fresh empty folder per turn, under the temp folder (resolved: /private on macOS).
    expect(seen.cwd.startsWith(await realpath(tmpdir()))).toBe(true);
    expect(seen.cwd).toMatch(/turn-[^/]+$/);
    // macOS adds __CF_USER_TEXT_ENCODING to every process; Linux adds nothing.
    const names = (seen.envNames as string[]).filter(
      (name) => !name.startsWith('__CF_'),
    );
    expect(names.sort()).toEqual(
      ['CODEX_HOME', 'HOME', 'KB_CHAT_MCP_TOKEN', 'LANG', 'PATH'].sort(),
    );
    expect(seen.args).toEqual(
      expect.arrayContaining([
        '--ignore-user-config',
        '-c',
        'features.browser_use=false',
      ]),
    );
    expect(JSON.stringify(seen.args)).toContain(mcp.baseUrl);
  });

  it('reports a logged-out Codex, both per turn and on /status', async () => {
    await fake({ mode: 'fail' });
    expect((await collect()).at(-1)).toEqual({
      type: 'error',
      code: 'CLI_LOGIN_REQUIRED',
    });
    expect(await (await fetch(`${runner.url}/status`)).json()).toEqual({
      loggedIn: false,
    });
    await fake({});
    expect(await (await fetch(`${runner.url}/status`)).json()).toEqual({
      loggedIn: true,
    });
  });

  it('stops the Codex process when the API gives up on the turn', async () => {
    await fake({ mode: 'sleep' });
    const controller = new AbortController();
    const events: ResearchEvent[] = [];
    const stream = apiRunner().run({
      topic: 'hermetismo',
      question: 'q',
      history: [],
      profile: 'fast',
      signal: controller.signal,
    });
    for await (const event of stream) {
      events.push(event);
      if (event.type === 'token') controller.abort();
    }
    await expect.poll(() => runner.active(), { timeout: 8000 }).toBe(0);
  });

  it('refuses a malformed turn, and arguments it did not build itself (review F2)', async () => {
    const post = (body: object) =>
      fetch(`${runner.url}/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post({ input: 1 })).status).toBe(400);
    expect(
      (
        await post({
          args: ['exec', '--dangerously-bypass-approvals-and-sandbox'],
          input: 'x',
          token: 'x'.repeat(32),
        })
      ).status,
    ).toBe(400);
    expect(
      (await post({ model: '--sandbox', input: 'x', token: 'x'.repeat(32) }))
        .status,
    ).toBe(400);
  });

  it('runs one turn at a time, so no turn can see another one’s token (review R3)', async () => {
    await fake({ mode: 'sleep' });
    const first = new AbortController();
    const second = new AbortController();
    const firstTurn = apiRunner().run({
      topic: 'hermetismo',
      question: 'q1',
      history: [],
      profile: 'fast',
      signal: first.signal,
    });
    // Read the first turn to its end (in the background), so nothing is left open.
    let sawToken: () => void = () => undefined;
    const tokenSeen = new Promise<void>((resolve) => {
      sawToken = resolve;
    });
    const firstDone = (async () => {
      for await (const event of firstTurn)
        if (event.type === 'token') sawToken();
    })();
    await tokenSeen;
    const secondTurn = (async () => {
      const events: ResearchEvent[] = [];
      for await (const event of apiRunner().run({
        topic: 'hermetismo',
        question: 'q2',
        history: [],
        profile: 'fast',
        signal: second.signal,
      }))
        events.push(event);
      return events;
    })();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(runner.active()).toBe(1);
    first.abort();
    await firstDone;
    await expect.poll(() => runner.active(), { timeout: 8000 }).toBe(1);
    second.abort();
    await secondTurn;
    await expect.poll(() => runner.active(), { timeout: 8000 }).toBe(0);
  });
});

describe('Who may call the runner (review R3)', () => {
  it('answers turns only from the API’s address', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kbchat-codex-home-'));
    const guarded = await startCodexRunner({
      bin: join(FAKES_DIR, 'fake-codex.mjs'),
      codexHome: home,
      mcpUrl: 'http://172.30.0.2:3000/mcp/turn',
      host: '127.0.0.1',
      port: 0,
      env: { PATH: process.env['PATH'] ?? '' },
      allowedClients: ['172.30.0.2'],
    });
    const turn = await fetch(`${guarded.url}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'x', token: 'x'.repeat(32) }),
    });
    expect(turn.status).toBe(403);
    expect((await fetch(`${guarded.url}/status`)).status).toBe(403);
    // The container's own healthcheck still works.
    expect((await fetch(`${guarded.url}/health`)).status).toBe(200);
    await guarded.close();
  });

  it('never keeps the lock of a turn that could not start', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kbchat-codex-home-'));
    const broken = await startCodexRunner({
      bin: join(FAKES_DIR, 'fake-codex.mjs'),
      codexHome: home,
      mcpUrl: 'http://127.0.0.1:9/mcp/turn',
      host: '127.0.0.1',
      port: 0,
      env: { PATH: process.env['PATH'] ?? '' },
      tmpRoot: join(home, 'missing', 'folder'),
    });
    const post = () =>
      fetch(`${broken.url}/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'x', token: 'x'.repeat(32) }),
      });
    expect((await post()).status).toBe(500);
    // The next turn is not stuck behind the failed one.
    expect((await post()).status).toBe(500);
    await broken.close();
  });

  it('never starts a turn whose caller left while it waited (review 2.2)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kbchat-codex-home-'));
    await writeFile(
      join(home, 'fake-cli.json'),
      JSON.stringify({ mode: 'sleep' }),
    );
    const queued = await startCodexRunner({
      bin: join(FAKES_DIR, 'fake-codex.mjs'),
      codexHome: home,
      mcpUrl: 'http://127.0.0.1:9/mcp/turn',
      host: '127.0.0.1',
      port: 0,
      env: { PATH: process.env['PATH'] ?? '' },
    });
    const post = (signal: AbortSignal) =>
      fetch(`${queued.url}/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'x', token: 'x'.repeat(32) }),
        signal,
      }).catch(() => null);
    const first = new AbortController();
    const second = new AbortController();
    void post(first.signal);
    await expect.poll(() => queued.active(), { timeout: 8000 }).toBe(1);
    void post(second.signal);
    await new Promise((resolve) => setTimeout(resolve, 300));
    second.abort();
    await new Promise((resolve) => setTimeout(resolve, 300));
    first.abort();
    await expect.poll(() => queued.active(), { timeout: 8000 }).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(queued.counts().turns).toBe(1);
    await queued.close();
  });
});
