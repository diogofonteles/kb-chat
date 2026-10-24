import { mkdir } from 'node:fs/promises';
import type { AiTestCode, ResearchEvent } from '@kb-chat/contracts';
import type { McpTurnRegistry } from '../mcp/mcp-turns.js';
import { mcpTurnPath } from '../mcp/mcp-routes.js';
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

/** How one official CLI is called and read (Claude Code, Codex). */
export interface CliDialect {
  readonly name: string;
  args(mcpUrl: string, input: ResearchInput): readonly string[];
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

async function startCli(
  options: CliTurnOptions,
  dialect: CliDialect,
  call: { readonly input: TurnInput; readonly token: string },
): Promise<CliProcess> {
  await mkdir(options.workDir, { recursive: true, mode: 0o700 });
  return spawnCli({
    bin: options.bin,
    args: dialect.args(
      `${options.apiBaseUrl}${mcpTurnPath(call.token)}`,
      call.input,
    ),
    cwd: options.workDir,
    env: subscriptionEnv(options.env),
    input: dialect.input(call.input),
  });
}

/**
 * One research turn run by a subscription CLI (KBC-007 FR-4): the tools are served to it
 * over the turn's MCP endpoint, its stdout becomes tokens, and each tool call it makes
 * becomes a step and a sources event. Aborting kills the CLI's process group.
 */
export async function* runCliTurn(
  options: CliTurnOptions,
  dialect: CliDialect,
  input: TurnInput,
): AsyncIterable<ResearchEvent> {
  const turn = new CliTurn(dialect, options.model);
  const endpoint = options.turns.open(input.tools, {
    onResult: (result) => turn.onToolResult(result),
  });
  const cli = await startCli(options, dialect, {
    input,
    token: endpoint.token,
  });
  const abort = () => cli.kill();
  input.signal.addEventListener('abort', abort, { once: true });
  void turn
    .read(cli)
    .catch(() => undefined)
    .then(() => turn.finish(input.signal.aborted));
  try {
    yield* turn.queue;
  } finally {
    input.signal.removeEventListener('abort', abort);
    cli.kill();
    endpoint.close();
  }
}
