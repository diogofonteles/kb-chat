import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResearchEvent } from '@kb-chat/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeResearchTools } from '../../test/fake-research-tools.js';
import { FAKES_DIR } from '../../test/fixture-paths.js';
import { CodexCliRunner } from '../adapters/codex-cli-runner.js';
import { McpTurnRegistry } from '../mcp/mcp-turns.js';
import {
  startMcpTurnServer,
  type McpTurnServer,
} from '../mcp/mcp-turn-server.js';
import { startCodexRunner, type CodexRunner } from './runner-server.js';

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
    runner: { url: runner.url, mcpBaseUrl: mcp.baseUrl },
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

  it('refuses a malformed turn', async () => {
    const response = await fetch(`${runner.url}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: 'exec', input: 1 }),
    });
    expect(response.status).toBe(400);
  });
});
