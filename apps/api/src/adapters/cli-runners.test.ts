import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResearchEvent, ResearchProfile } from '@kb-chat/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeResearchTools } from '../../test/fake-research-tools.js';
import { answerText } from '../../test/research-factories.js';
import { FAKES_DIR } from '../../test/fixture-paths.js';
import { freePort } from '../../test/free-port.js';
import { mcpRoutes } from '../mcp/mcp-routes.js';
import { PLAN_STEPS, turnToolsFactory } from '../modules/research/index.js';
import { fixtureTools } from '../../test/research-factories.js';
import { McpTurnRegistry } from '../mcp/mcp-turns.js';
import type { ResearchRunnerPort } from '../ports/research-runner.js';
import type { ResearchToolsPort } from '../ports/research-tools.js';
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
import { stopOnAbort } from './cli-research-turn.js';

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

/** The real research tools over the fixture vault, for exhaustive turns (KBC-030). */
async function sweepTools() {
  return turnToolsFactory(await fixtureTools())('hermetismo');
}

interface LoggedRun {
  readonly args: string[];
  readonly stdin: string;
  readonly system?: string;
}

/** The runs a fake CLI logged, one JSON line each. */
async function logged(path: string): Promise<LoggedRun[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedRun);
}

const sweepOf = (events: readonly ResearchEvent[], status: string) =>
  events.flatMap((e) =>
    e.type === 'sweep' && e.sweep.status === status ? [e.sweep] : [],
  )[0];

/** A HOME whose fake-cli.json sets the fake CLI's mode and report file. */
async function fakeHome(settings: {
  readonly mode?: string;
  readonly report?: string;
  readonly log?: string;
}): Promise<NodeJS.ProcessEnv> {
  const home = await mkdtemp(join(tmpdir(), 'kbchat-home-'));
  await writeFile(join(home, 'fake-cli.json'), JSON.stringify(settings));
  return { HOME: home };
}

async function collect(
  runner: ResearchRunnerPort,
  signal = new AbortController().signal,
  profile: ResearchProfile = 'fast',
): Promise<ResearchEvent[]> {
  const events: ResearchEvent[] = [];
  for await (const event of runner.run({
    topic: 'hermetismo',
    question: 'O que é o ritmo?',
    history: [{ question: 'Antes', answer: 'Resposta anterior' }],
    profile,
    signal,
  }))
    events.push(event);
  return events;
}

function claude(
  env: NodeJS.ProcessEnv = {},
  tools: ResearchToolsPort = new FakeResearchTools(),
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

  it('never shows a marker written after a sentence, even split across deltas', async () => {
    const events = await collect(
      escalating(await fakeHome({ mode: 'deepen-mid' })),
    );
    const shown = events
      .flatMap((e) => (e.type === 'token' ? [e.text] : []))
      .join('');
    expect(shown).toContain('Achei só parte da lista.');
    expect(shown).not.toContain('<');
    expect(answerText(events)).toBe('Segundo o acervo, tudo flui [1].');
    expect(events.at(-1)).toMatchObject({ type: 'done', escalated: true });
  });

  it('never starts the deep CLI when the reader stops on "Aprofundando…"', async () => {
    const report = join(workDir, 'stopped.json');
    const abort = new AbortController();
    const events: ResearchEvent[] = [];
    const runner = escalating(await fakeHome({ mode: 'deepen', report }));
    for await (const event of runner.run({
      topic: 'hermetismo',
      question: 'q',
      history: [],
      profile: 'fast',
      signal: abort.signal,
    })) {
      events.push(event);
      if (event.type === 'step' && event.step.kind === 'deepen') abort.abort();
    }
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      interrupted: true,
      escalated: true,
    });
    // The report is the fast run's: the deep (opus) run never started.
    const seen = JSON.parse(await readFile(report, 'utf8'));
    expect(seen.args).not.toContain('--model=opus');
    expect(turns.size).toBe(0);
  });

  it('stops at once when the reader aborted before the CLI was watched', () => {
    const stop = vi.fn();
    const aborted = new AbortController();
    aborted.abort();
    stopOnAbort(aborted.signal, stop)();
    expect(stop).toHaveBeenCalledOnce();
    const live = new AbortController();
    const later = vi.fn();
    const unwatch = stopOnAbort(live.signal, later);
    unwatch();
    live.abort();
    expect(later).not.toHaveBeenCalled();
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
    expect(answerText(off)).toBe('O acervo não traz essa lista. ');
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

  it('runs an exhaustive turn as a plan, one CLI run per batch and an answer, with the coverage the app measured (KBC-030)', async () => {
    const log = join(workDir, 'sweep-claude.jsonl');
    const open = vi.spyOn(turns, 'open');
    const events = await collect(
      claude(await fakeHome({ mode: 'plan', log }), await sweepTools()),
      undefined,
      'exhaustive',
    );
    const runs = await logged(log);
    const planned = sweepOf(events, 'planned');
    // Planning first, over MCP with plan_sweep; then one run per batch; then the answer.
    const systemOf = (run?: LoggedRun) =>
      run?.args[run.args.indexOf('--system-prompt') + 1] ?? '';
    expect(systemOf(runs[0])).toContain('Pesquisa exaustiva');
    expect(open.mock.calls[0]?.[2]).toBe(PLAN_STEPS + 1);
    const batches = runs.filter((r) => r.system?.startsWith('Você lê um lote'));
    expect(batches).toHaveLength(planned?.batches ?? -1);
    expect(systemOf(runs.at(-1))).toContain('O aplicativo já varreu');
    for (const run of runs) {
      expect(run.args[run.args.indexOf('--tools') + 1]).toBe('');
      expect(run.args).not.toContain('--agents');
    }
    const done = events.at(-1);
    expect(done).toMatchObject({
      type: 'done',
      billing: 'subscription',
      coverage: {
        target: { authorship: 'mestre-laercio' },
        phrases: ['ritmo'],
        missing: 0,
      },
    });
    expect(answerText(events)).toMatch(/trata do ritmo \[\d+\]/);
    expect(answerText(events)).not.toMatch(/cobertura|9\.999/i);
    expect(
      events.some((e) => e.type === 'step' && e.step.kind === 'sweep'),
    ).toBe(true);
    expect(turns.size).toBe(0);
    open.mockRestore();
  });

  it('sweeps with the default plan when the CLI answers instead of planning (lazy)', async () => {
    const events = await collect(
      claude(await fakeHome({}), await sweepTools()),
      undefined,
      'exhaustive',
    );
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type !== 'done') return;
    expect(done.coverage?.target).toEqual({});
    expect(done.coverage?.read).toBe(done.coverage?.documents);
    expect(answerText(events)).not.toContain('tudo flui');
  });

  it('ends an exhaustive turn whose CLI is logged out with CLI_LOGIN_REQUIRED', async () => {
    const events = await collect(
      claude(await fakeHome({ mode: 'login' }), await sweepTools()),
      undefined,
      'exhaustive',
    );
    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'CLI_LOGIN_REQUIRED',
    });
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

  it('runs an exhaustive Codex turn through the same sweep, one run at a time, every run locked down (KBC-030)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kbchat-codex-sweep-'));
    const log = join(dir, 'runs.jsonl');
    const tools = await sweepTools();
    const runner = new CodexCliRunner({
      bin: join(FAKES_DIR, 'fake-codex.mjs'),
      apiBaseUrl,
      turns,
      workDir: dir,
      env: { ...process.env, ...(await fakeHome({ mode: 'plan', log })) },
      tools: () => tools,
    });
    const events = await collect(runner, undefined, 'exhaustive');
    const runs = await logged(log);
    const planned = sweepOf(events, 'planned');
    const batches = runs.filter((r) => r.stdin.startsWith('Você lê um lote'));
    expect(batches).toHaveLength(planned?.batches ?? -1);
    for (const run of runs)
      expect(run.args).toEqual(
        expect.arrayContaining([
          '-c',
          'features.shell_tool=false',
          '--sandbox',
          'read-only',
        ]),
      );
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      coverage: { phrases: ['ritmo'], missing: 0 },
    });
    expect(answerText(events)).not.toMatch(/cobertura/i);
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
    // A line with parent_tool_use_id is never answer text.
    expect(
      parseClaudeLine(
        '{"type":"stream_event","parent_tool_use_id":"toolu_1","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"interno"}}}',
      ),
    ).toEqual({});
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
        DISABLE_AUTOUPDATER: '1',
      }),
    ).toEqual({ PATH: '/bin', HOME: '/Users/owner', DISABLE_AUTOUPDATER: '1' });
  });
});
