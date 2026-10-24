import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResearchEvent } from '@kb-chat/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeResearchTools } from '../../test/fake-research-tools.js';
import { answerText } from '../../test/research-factories.js';
import { FAKES_DIR } from '../../test/fixture-paths.js';
import { freePort } from '../../test/free-port.js';
import { mcpRoutes } from '../mcp/mcp-routes.js';
import { McpTurnRegistry } from '../mcp/mcp-turns.js';
import type { ResearchRunnerPort } from '../ports/research-runner.js';
import {
  CLAUDE_EFFORT,
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

/** A HOME whose fake-cli.json sets the fake CLI's mode and report file. */
async function fakeHome(settings: {
  readonly mode?: string;
  readonly report?: string;
}): Promise<NodeJS.ProcessEnv> {
  const home = await mkdtemp(join(tmpdir(), 'kbchat-home-'));
  await writeFile(join(home, 'fake-cli.json'), JSON.stringify(settings));
  return { HOME: home };
}

async function collect(
  runner: ResearchRunnerPort,
  signal = new AbortController().signal,
): Promise<ResearchEvent[]> {
  const events: ResearchEvent[] = [];
  for await (const event of runner.run({
    topic: 'hermetismo',
    question: 'O que é o ritmo?',
    history: [{ question: 'Antes', answer: 'Resposta anterior' }],
    profile: 'fast',
    signal,
  }))
    events.push(event);
  return events;
}

function claude(
  env: NodeJS.ProcessEnv = {},
  tools = new FakeResearchTools(),
  dir = workDir,
) {
  return new ClaudeCliRunner({
    bin: join(FAKES_DIR, 'fake-claude.mjs'),
    apiBaseUrl,
    turns,
    workDir: dir,
    env: { ...process.env, ...env },
    tools: () => tools,
    killGraceMs: 200,
  });
}

/** A Claude runner on Sonnet that may escalate to Opus (ADR 0009). */
function escalating(env: NodeJS.ProcessEnv, enabled = true) {
  return new ClaudeCliRunner({
    bin: join(FAKES_DIR, 'fake-claude.mjs'),
    apiBaseUrl,
    turns,
    workDir,
    env: { ...process.env, ...env },
    tools: () => new FakeResearchTools(),
    model: 'sonnet',
    escalation: { deep: 'opus', enabled: () => enabled },
    killGraceMs: 200,
  });
}

describe('ClaudeCliRunner auto-escalation (ADR 0009)', () => {
  it('runs the deep model with the fast findings when the fast pass asks to go deeper', async () => {
    const report = join(workDir, 'deepen.json');
    const events = await collect(
      escalating(await fakeHome({ mode: 'deepen', report })),
    );
    const steps = events.flatMap((e) => (e.type === 'step' ? [e.step] : []));
    expect(steps.map((s) => s.kind)).toEqual(['search', 'deepen', 'search']);
    expect(
      events.some((e) => e.type === 'token' && e.text.includes('<<')),
    ).toBe(false);
    expect(answerText(events)).toBe('Segundo o acervo, tudo flui [1].');
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      escalated: true,
      steps: 2,
    });
    // The report holds the second (deep) run: Opus, told what the fast pass found.
    const seen = JSON.parse(await readFile(report, 'utf8'));
    expect(seen.args).toContain('--model=opus');
    expect(seen.args).not.toContain('--effort=low');
    expect(seen.stdin).toContain('<findings>');
    expect(seen.stdin).toContain('Faça a sua própria pesquisa');
    expect(seen.stdin).toContain('[1] A Lei do Ritmo');
    expect(turns.size).toBe(0);
  });

  it('escalates an answer that gives up on the collection, and not when Settings turn it off', async () => {
    const events = await collect(
      escalating(await fakeHome({ mode: 'absent' })),
    );
    expect(events.some((e) => e.type === 'retract')).toBe(true);
    expect(answerText(events)).toBe('Segundo o acervo, tudo flui [1].');
    const off = await collect(
      escalating(await fakeHome({ mode: 'absent' }), false),
    );
    expect(answerText(off)).toBe('O acervo não nomeia os cinco princípios. ');
    expect(off.at(-1)).not.toHaveProperty('escalated');
  });
});

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
      // The narration before the tool call and the leading "Tenho tudo…" are dropped.
      { type: 'token', text: 'Segundo o acervo, tudo flui [1].', segment: 1 },
      {
        type: 'done',
        usd: 0,
        billing: 'subscription',
        model: 'claude-fake-1',
        interrupted: false,
        steps: 1,
      },
    ]);
    expect(tools.calls).toHaveLength(1);
    expect(turns.size).toBe(0);
  });

  it('streams text written before a tool call at once, then retracts it (ADR 0009)', async () => {
    const events = await collect(claude(await fakeHome({ mode: 'aloud' })));
    expect(events.slice(0, 2)).toEqual([
      {
        type: 'token',
        text: 'Os textos sobre o ritmo parecem ser dois. ',
        segment: 0,
      },
      { type: 'retract', segment: 0 },
    ]);
    expect(events.filter((e) => e.type === 'token').at(-1)).toMatchObject({
      text: 'Segundo o acervo, tudo flui [1].',
      segment: 1,
    });
  });

  it('starts claude without ANTHROPIC_API_KEY, with the question on stdin (AC-7)', async () => {
    const report = join(workDir, 'report.json');
    await collect(
      claude({
        ANTHROPIC_API_KEY: 'sk-ant-must-not-leak',
        ANTHROPIC_AUTH_TOKEN: 'token',
        KB_CHAT_UNRELATED_SECRET: 'server-only',
        ...(await fakeHome({ report })),
      }),
    );
    const seen = JSON.parse(await readFile(report, 'utf8'));
    expect(seen.env).toEqual([]);
    // The MCP URL (with the turn token) is in a 0600 file, never in argv.
    expect(seen.configMode).toBe(0o600);
    expect(JSON.stringify(seen.args)).not.toContain('/mcp/turns/');
    expect(seen.stdin).toContain('<question>O que é o ritmo?</question>');
    expect(seen.stdin).toContain('<answer>Resposta anterior</answer>');
    expect(seen.args).toEqual(
      expect.arrayContaining(['--tools', '', '--strict-mcp-config']),
    );
    expect(JSON.stringify(seen.args)).not.toContain('sk-ant');
    // The in-API loop's research rules, so Claude greps before concluding absence.
    const prompt = String(seen.args[seen.args.indexOf('--system-prompt') + 1]);
    expect(prompt).toContain('“hermetismo”');
    expect(prompt).toContain('find_text');
    expect(prompt).toContain('(fora do acervo)');
    expect(seen.envNames).toContain('PATH');
    expect(seen.envNames).not.toContain('KB_CHAT_UNRELATED_SECRET');
  });

  it('kills a CLI that ignores SIGTERM and closes the endpoint on abort', async () => {
    const abort = new AbortController();
    const events: ResearchEvent[] = [];
    for await (const event of claude(await fakeHome({ mode: 'stubborn' })).run({
      topic: 'hermetismo',
      question: 'q',
      history: [],
      profile: 'deep',
      signal: abort.signal,
    })) {
      events.push(event);
      if (event.type === 'token') {
        abort.abort();
        expect(turns.size).toBe(0);
      }
    }
    expect(events.at(-1)).toMatchObject({ type: 'done', interrupted: true });
  });

  it('closes the turn endpoint when the CLI cannot start', async () => {
    const blocker = join(workDir, 'not-a-folder');
    await writeFile(blocker, '');
    const run = collect(
      claude({}, new FakeResearchTools(), join(blocker, 'x')),
    );
    await expect(run).rejects.toThrow();
    expect(turns.size).toBe(0);
  });

  it('kills the CLI and ends as interrupted when the reader stops (abort)', async () => {
    const abort = new AbortController();
    const events: ResearchEvent[] = [];
    for await (const event of claude(await fakeHome({ mode: 'sleep' })).run({
      topic: 'hermetismo',
      question: 'q',
      history: [],
      profile: 'deep',
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
    const events = await collect(claude(await fakeHome({ mode: 'login' })));
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
  const codex = (env: NodeJS.ProcessEnv = {}, dir = workDir) =>
    new CodexCliRunner({
      bin: join(FAKES_DIR, 'fake-codex.mjs'),
      apiBaseUrl,
      turns,
      workDir: dir,
      env: { ...process.env, ...env },
      tools: () => new FakeResearchTools(),
    });

  it('runs Codex on a private CODEX_HOME with only the owner login, the token by env', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kbchat-codex-'));
    const ownerHome = join(dir, 'owner-codex');
    await mkdir(ownerHome);
    await writeFile(join(ownerHome, 'auth.json'), '{"login":"owner"}');
    await writeFile(join(ownerHome, 'config.toml'), '[mcp_servers.other]');
    const report = join(dir, 'report.json');
    const workDirOfCodex = join(dir, 'work');
    const events = await collect(
      codex(
        { CODEX_HOME: ownerHome, ...(await fakeHome({ report })) },
        workDirOfCodex,
      ),
    );
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    const seen = JSON.parse(await readFile(report, 'utf8'));
    const home = join(workDirOfCodex, 'home');
    expect(seen.codexHome).toBe(home);
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(
      '{"login":"owner"}',
    );
    expect((await stat(join(home, 'auth.json'))).mode & 0o777).toBe(0o600);
    await expect(stat(join(home, 'config.toml'))).rejects.toThrow();
    expect(JSON.stringify(seen.args)).not.toContain('/mcp/turns/');
    expect(seen.args).toEqual(
      expect.arrayContaining(['-c', 'features.shell_tool=false']),
    );
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
    const events = await collect(codex(await fakeHome({ mode: 'fail' })));
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
    ).toEqual({});
    expect(
      parseClaudeLine(
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Oi"}}}',
      ),
    ).toEqual({ text: 'Oi' });
    expect(
      parseClaudeLine(
        '{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"tool_use"}}}',
      ),
    ).toEqual({ messageEnd: 'tool_use' });
    expect(
      parseClaudeLine(
        '{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"}}}',
      ),
    ).toEqual({ messageEnd: 'answer' });
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
    ).toEqual({});
    expect(
      parseCodexLine(
        '{"type":"item.completed","item":{"type":"agent_message","text":"Resposta"}}',
      ),
    ).toEqual({ text: 'Resposta\n\n' });
    expect(parseCodexLine('[]')).toEqual({});
    expect(parseCodexLine('{')).toEqual({});
  });

  it('builds argument lists with only the kb tools and no shell', () => {
    const args = claudeArgs('/turn/mcp.json', {
      model: 'opus',
      systemPrompt: 'rules',
    });
    expect(args).toEqual(
      expect.arrayContaining([
        '-p',
        '--system-prompt',
        'rules',
        '--allowedTools',
        'mcp__kb',
        '--no-session-persistence',
        '--model=opus',
      ]),
    );
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/turn/mcp.json');
    expect(args.some((arg) => arg.startsWith('--effort'))).toBe(false);
    // The fast profile thinks less between tool calls (KBC-011).
    expect(
      claudeArgs('/m.json', {
        systemPrompt: 'r',
        effort: CLAUDE_EFFORT.fast,
      }),
    ).toContain('--effort=low');
    expect(CLAUDE_EFFORT.deep).toBeUndefined();
    expect(codexArgs('http://x', 'gpt-5.5')).toEqual(
      expect.arrayContaining([
        'exec',
        '--json',
        '--sandbox',
        'read-only',
        '-c',
        'mcp_servers.kb.url="http://x"',
        '-c',
        'mcp_servers.kb.bearer_token_env_var="KB_CHAT_MCP_TOKEN"',
        '--model=gpt-5.5',
        '-',
      ]),
    );
  });

  it('hands the CLI only allowlisted variables, never an API credential (BR-7)', () => {
    expect(
      subscriptionEnv({
        PATH: '/bin',
        HOME: '/Users/owner',
        ANTHROPIC_API_KEY: 'a',
        OPENAI_API_KEY: 'b',
        OPENROUTER_API_KEY: 'c',
        KB_CHAT_STATE_DIR: '/state',
      }),
    ).toEqual({ PATH: '/bin', HOME: '/Users/owner' });
  });
});
