import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResearchEvent } from '@kb-chat/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeResearchTools } from '../../test/fake-research-tools.js';
import { FAKES_DIR } from '../../test/fixture-paths.js';
import { freePort } from '../../test/free-port.js';
import { mcpRoutes } from '../mcp/mcp-routes.js';
import { McpTurnRegistry } from '../mcp/mcp-turns.js';
import type { ResearchRunnerPort } from '../ports/research-runner.js';
import {
  ClaudeCliRunner,
  claudeArgs,
  parseClaudeLine,
} from './claude-cli-runner.js';
import {
  CodexCliRunner,
  codexArgs,
  parseCodexLine,
} from './codex-cli-runner.js';
import { subscriptionEnv } from './cli-process.js';

const turns = new McpTurnRegistry();
let server: FastifyInstance;
let apiBaseUrl: string;
let workDir: string;

beforeAll(async () => {
  server = Fastify();
  await server.register(mcpRoutes(turns));
  const port = await freePort();
  await server.listen({ host: '127.0.0.1', port });
  apiBaseUrl = `http://127.0.0.1:${port}`;
  workDir = await mkdtemp(join(tmpdir(), 'kbchat-cli-'));
});

afterAll(async () => {
  await server.close();
});

async function collect(
  runner: ResearchRunnerPort,
  signal = new AbortController().signal,
): Promise<ResearchEvent[]> {
  const events: ResearchEvent[] = [];
  for await (const event of runner.run({
    topic: 'hermetismo',
    question: 'O que é o ritmo?',
    history: [{ question: 'Antes', answer: 'Resposta anterior' }],
    signal,
  }))
    events.push(event);
  return events;
}

function claude(env: NodeJS.ProcessEnv = {}, tools = new FakeResearchTools()) {
  return new ClaudeCliRunner({
    bin: join(FAKES_DIR, 'fake-claude.mjs'),
    apiBaseUrl,
    turns,
    workDir,
    env: { ...process.env, ...env },
    tools: () => tools,
  });
}

describe('ClaudeCliRunner', () => {
  it('streams the steps, the sources and the [n] text, free of charge (AC-4)', async () => {
    const tools = new FakeResearchTools();
    const events = await collect(claude({}, tools));
    expect(events).toEqual([
      { type: 'step', step: { kind: 'search', text: 'Buscando “ritmo”' } },
      {
        type: 'sources',
        sources: [
          {
            n: 1,
            id: 'raw/articles/a-lei-do-ritmo.md',
            title: 'A Lei do Ritmo',
          },
        ],
      },
      { type: 'token', text: 'Segundo o acervo, ' },
      { type: 'token', text: 'tudo flui [1].' },
      {
        type: 'done',
        usd: 0,
        model: 'claude-fake-1',
        interrupted: false,
        steps: 1,
      },
    ]);
    expect(tools.calls).toHaveLength(1);
    expect(turns.size).toBe(0);
  });

  it('starts claude without ANTHROPIC_API_KEY, with the question on stdin (AC-7)', async () => {
    const report = join(workDir, 'report.json');
    await collect(
      claude({
        ANTHROPIC_API_KEY: 'sk-ant-must-not-leak',
        ANTHROPIC_AUTH_TOKEN: 'token',
        FAKE_CLAUDE_REPORT: report,
      }),
    );
    const seen = JSON.parse(await readFile(report, 'utf8'));
    expect(seen.env).toEqual([]);
    expect(seen.stdin).toContain('<question>O que é o ritmo?</question>');
    expect(seen.stdin).toContain('<answer>Resposta anterior</answer>');
    expect(seen.args).toEqual(
      expect.arrayContaining(['--tools', '', '--strict-mcp-config']),
    );
    expect(JSON.stringify(seen.args)).not.toContain('sk-ant');
  });

  it('kills the CLI and ends as interrupted when the reader stops (abort)', async () => {
    const abort = new AbortController();
    const events: ResearchEvent[] = [];
    for await (const event of claude({ FAKE_CLAUDE_MODE: 'sleep' }).run({
      topic: 'hermetismo',
      question: 'q',
      history: [],
      signal: abort.signal,
    })) {
      events.push(event);
      if (event.type === 'token') abort.abort();
    }
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      interrupted: true,
      usd: 0,
    });
  });

  it('reports CLI_LOGIN_REQUIRED when claude is not logged in', async () => {
    const events = await collect(claude({ FAKE_CLAUDE_MODE: 'login' }));
    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'CLI_LOGIN_REQUIRED',
    });
  });

  it('refuses without research tools and reports itself unconfigured', async () => {
    const runner = new ClaudeCliRunner({
      bin: 'claude',
      apiBaseUrl,
      turns,
      workDir,
      env: {},
    });
    expect(runner.configured()).toBe(false);
    expect(runner.billing).toBe('subscription');
    expect(await collect(runner)).toEqual([
      { type: 'error', code: 'LLM_NOT_CONFIGURED' },
    ]);
  });
});

describe('CodexCliRunner', () => {
  const codex = (env: NodeJS.ProcessEnv = {}) =>
    new CodexCliRunner({
      bin: join(FAKES_DIR, 'fake-codex.mjs'),
      apiBaseUrl,
      turns,
      workDir,
      env: { ...process.env, ...env },
      tools: () => new FakeResearchTools(),
    });

  it('streams a Codex turn with its MCP step and free cost', async () => {
    const events = await collect(codex());
    expect(events.map((e) => e.type)).toEqual([
      'step',
      'sources',
      'token',
      'done',
    ]);
    expect(events.at(-1)).toMatchObject({ usd: 0, model: 'codex', steps: 1 });
  });

  it('reports a failed turn', async () => {
    const events = await collect(codex({ FAKE_CODEX_MODE: 'fail' }));
    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'CLI_LOGIN_REQUIRED',
    });
  });
});

describe('CLI dialects', () => {
  it('reads the verified Claude Code stream-json shapes and ignores the rest', () => {
    expect(
      parseClaudeLine('{"type":"system","subtype":"init","model":"m"}'),
    ).toEqual({ model: 'm' });
    expect(parseClaudeLine('{"type":"system","subtype":"hook"}')).toEqual({});
    expect(
      parseClaudeLine(
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}}',
      ),
    ).toEqual({ events: [] });
    expect(
      parseClaudeLine('{"type":"result","subtype":"error_max_turns"}'),
    ).toEqual({
      result: { ok: false, code: 'PROVIDER_UNAVAILABLE' },
    });
    expect(parseClaudeLine('{"type":"assistant","message":{}}')).toEqual({});
    expect(parseClaudeLine('not json')).toEqual({});
  });

  it('reads Codex events', () => {
    expect(parseCodexLine('{"type":"turn.completed","usage":{}}')).toEqual({
      result: { ok: true },
    });
    expect(
      parseCodexLine('{"type":"turn.failed","error":{"message":"boom"}}'),
    ).toEqual({
      result: { ok: false, code: 'PROVIDER_UNAVAILABLE' },
    });
    expect(
      parseCodexLine(
        '{"type":"item.completed","item":{"type":"reasoning","text":"x"}}',
      ),
    ).toEqual({ events: [] });
    expect(parseCodexLine('[]')).toEqual({});
    expect(parseCodexLine('{')).toEqual({});
  });

  it('builds argument lists with only the kb tools and no shell', () => {
    const args = claudeArgs('http://127.0.0.1:1/mcp/turns/t', {
      model: 'opus',
    });
    expect(args).toEqual(
      expect.arrayContaining([
        '-p',
        '--allowedTools',
        'mcp__kb',
        '--no-session-persistence',
        '--model',
        'opus',
      ]),
    );
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1] ?? '')).toEqual({
      mcpServers: {
        kb: { type: 'http', url: 'http://127.0.0.1:1/mcp/turns/t' },
      },
    });
    expect(codexArgs('http://x', 'gpt-5.5')).toEqual(
      expect.arrayContaining([
        'exec',
        '--json',
        '--sandbox',
        'read-only',
        '-c',
        'mcp_servers.kb.url="http://x"',
        '--model',
        'gpt-5.5',
        '-',
      ]),
    );
  });

  it('drops every API credential from the CLI environment (BR-7)', () => {
    expect(
      subscriptionEnv({
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'a',
        OPENAI_API_KEY: 'b',
        OPENROUTER_API_KEY: 'c',
      }),
    ).toEqual({ PATH: '/bin' });
  });
});
