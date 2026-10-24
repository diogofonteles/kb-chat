import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiTestCode, ResearchEvent } from '@kb-chat/contracts';
import type { McpTurnRegistry } from '../mcp/mcp-turns.js';
import { MCP_BEARER_PATH, mcpTurnPath } from '../mcp/mcp-routes.js';
import type { ResearchInput } from '../ports/research-runner.js';
import type {
  ResearchToolResult,
  ResearchToolsPort,
} from '../ports/research-tools.js';
import { CliAnswer } from './cli-answer.js';
import { EventQueue } from './event-queue.js';
import { spawnCli, subscriptionEnv, type CliProcess } from './cli-process.js';

/** What one stdout line of a CLI means. */
export interface CliLine {
  /** Answer text, held by the narration rule before it is shown. */
  readonly text?: string;
  /** How the model's message ended, when the CLI says so: with tool calls or as an answer. */
  readonly messageEnd?: 'tool_use' | 'answer';
  readonly model?: string;
  /** The CLI's final verdict: success, or why it failed. */
  readonly result?:
    { readonly ok: true } | { readonly ok: false; readonly code: AiTestCode };
}

/** How a CLI reaches the turn's MCP endpoint; the token never goes through argv. */
export interface TurnAccess {
  /** The endpoint with the token in its path (for a 0600 config file). */
  readonly url: string;
  /** The endpoint that takes the token as `Authorization: Bearer` (for an env variable). */
  readonly bearerUrl: string;
  readonly token: string;
  /** A private folder (0700) of this turn only, removed when it ends. */
  readonly dir: string;
}

/** What a CLI is started with for one turn. */
export interface CliLaunch {
  readonly args: readonly string[];
  /** Added to the allowlisted environment. */
  readonly env?: Readonly<Record<string, string>>;
}

/** How one official CLI is called and read (Claude Code, Codex). */
export interface CliDialect {
  readonly name: string;
  launch(access: TurnAccess, input: ResearchInput): Promise<CliLaunch>;
  input(input: ResearchInput): string;
  parse(line: string): CliLine;
}

export interface CliTurnOptions {
  readonly bin: string;
  /** Where the API listens; the CLI reaches the turn's MCP endpoint there. */
  readonly apiBaseUrl: string;
  readonly turns: McpTurnRegistry;
  /** Private working folder (no project files, no CLAUDE.md, ADR 0007). */
  readonly workDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly model: string;
  /** SIGTERM → SIGKILL delay on abort; default KILL_GRACE_MS. */
  readonly killGraceMs?: number;
}

interface TurnState {
  model: string;
  steps: number;
  /** Sources already streamed: a sources event goes out only when the list grows. */
  sourcesSent: number;
  result: CliLine['result'];
}

function finalEvent(state: TurnState, aborted: boolean): ResearchEvent {
  if (aborted || state.result?.ok)
    return {
      type: 'done',
      // Covered by the subscription: no spend entry, no cap (KBC-007 BR-2).
      usd: 0,
      billing: 'subscription',
      model: state.model,
      interrupted: aborted,
      steps: state.steps,
    };
  return {
    type: 'error',
    code: state.result?.code ?? 'PROVIDER_UNAVAILABLE',
  };
}

/** The live state of one turn: its events, the CLI's verdict and the steps taken. */
class CliTurn {
  readonly queue = new EventQueue<ResearchEvent>();
  readonly state: TurnState;
  private readonly answer = new CliAnswer((text) =>
    this.queue.push({ type: 'token', text }),
  );

  constructor(
    private readonly dialect: CliDialect,
    model: string,
  ) {
    this.state = { model, steps: 0, sourcesSent: 0, result: undefined };
  }

  onToolResult({ step, sources }: ResearchToolResult): void {
    this.answer.toolCalled();
    this.state.steps += 1;
    if (step) this.queue.push({ type: 'step', step });
    if (sources.length === this.state.sourcesSent) return;
    this.state.sourcesSent = sources.length;
    this.queue.push({ type: 'sources', sources: [...sources] });
  }

  async read(cli: CliProcess): Promise<void> {
    for await (const line of cli.lines) if (line.trim()) this.apply(line);
    await cli.exit;
  }

  finish(aborted: boolean): void {
    this.answer.ended();
    this.queue.push(finalEvent(this.state, aborted));
    this.queue.end();
  }

  private apply(line: string): void {
    const parsed = this.dialect.parse(line);
    if (parsed.model) this.state.model = parsed.model;
    if (parsed.result) this.state.result = parsed.result;
    if (parsed.text) this.answer.text(parsed.text);
    if (parsed.messageEnd === 'tool_use') this.answer.toolCalled();
    if (parsed.messageEnd === 'answer') this.answer.ended();
  }
}

type TurnInput = ResearchInput & { readonly tools: ResearchToolsPort };

async function turnAccess(
  options: CliTurnOptions,
  token: string,
): Promise<TurnAccess> {
  await mkdir(options.workDir, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(options.workDir, 'turn-'));
  return {
    url: `${options.apiBaseUrl}${mcpTurnPath(token)}`,
    bearerUrl: `${options.apiBaseUrl}${MCP_BEARER_PATH}`,
    token,
    dir,
  };
}

async function startCli(
  options: CliTurnOptions,
  dialect: CliDialect,
  call: { readonly input: TurnInput; readonly access: TurnAccess },
): Promise<CliProcess> {
  const launch = await dialect.launch(call.access, call.input);
  return spawnCli({
    bin: options.bin,
    args: launch.args,
    cwd: options.workDir,
    env: { ...subscriptionEnv(options.env), ...launch.env },
    input: dialect.input(call.input),
    killGraceMs: options.killGraceMs,
  });
}

/** The turn's endpoint, its private folder and its CLI; nothing outlives the turn. */
async function openTurn(
  options: CliTurnOptions,
  dialect: CliDialect,
  { input, turn }: { readonly input: TurnInput; readonly turn: CliTurn },
) {
  const endpoint = options.turns.open(input.tools, {
    onResult: (result) => turn.onToolResult(result),
  });
  let dir: string | undefined;
  try {
    const access = await turnAccess(options, endpoint.token);
    dir = access.dir;
    const cli = await startCli(options, dialect, { input, access });
    const turnDir = dir;
    const close = () => {
      cli.kill();
      endpoint.close();
      void rm(turnDir, { recursive: true, force: true });
    };
    return { cli, endpoint, close };
  } catch (err) {
    endpoint.close();
    if (dir) await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * One research turn run by a subscription CLI (KBC-007 FR-4): the tools are served to it
 * over the turn's MCP endpoint, its stdout becomes tokens, and each tool call it makes
 * becomes a step and a sources event. Aborting closes the endpoint at once and kills the
 * CLI's process group (SIGTERM, then SIGKILL).
 */
export async function* runCliTurn(
  options: CliTurnOptions,
  dialect: CliDialect,
  input: TurnInput,
): AsyncIterable<ResearchEvent> {
  const turn = new CliTurn(dialect, options.model);
  const { cli, endpoint, close } = await openTurn(options, dialect, {
    input,
    turn,
  });
  const abort = () => {
    endpoint.close();
    cli.kill();
  };
  input.signal.addEventListener('abort', abort, { once: true });
  void turn
    .read(cli)
    .catch(() => undefined)
    .then(() => turn.finish(input.signal.aborted));
  try {
    yield* turn.queue;
  } finally {
    input.signal.removeEventListener('abort', abort);
    close();
  }
}
