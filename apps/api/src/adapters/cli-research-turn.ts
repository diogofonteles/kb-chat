import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AiTestCode,
  AnswerSource,
  ResearchEvent,
} from '@kb-chat/contracts';
import type { McpTurnRegistry } from '../mcp/mcp-turns.js';
import {
  AnswerStream,
  DEEPEN_STEP,
  DEFAULT_BUDGETS,
  deepenReason,
  findingsText,
  type ResearchBudgets,
} from '../modules/research/index.js';
import { MCP_BEARER_PATH, mcpTurnPath } from '../mcp/mcp-routes.js';
import type { Escalation, ResearchInput } from '../ports/research-runner.js';
import type {
  ResearchToolResult,
  ResearchToolsPort,
} from '../ports/research-tools.js';
import { EventQueue } from './event-queue.js';
import { spawnCli, subscriptionEnv, type CliProcess } from './cli-process.js';

/** What one stdout line of a CLI means. */
export interface CliLine {
  /** Answer text; it streams at once and is retracted if its message calls tools (ADR 0009). */
  readonly text?: string;
  /** How the model's message ended, when the CLI says so: with tool calls or as an answer. */
  readonly messageEnd?: 'tool_use' | 'answer';
  readonly model?: string;
  /** The main conversation started sub-agents with these descriptions (ADR 0014). */
  readonly delegates?: readonly string[];
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
  launch(access: TurnAccess, input: CliPassInput): Promise<CliLaunch>;
  input(input: CliPassInput): string;
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
  /** A fast turn's deep model (undefined: the CLI's own) to escalate to (ADR 0009). */
  readonly escalation?: Escalation<string | undefined>;
  /** Step budgets per profile (ADR 0013); default DEFAULT_BUDGETS. */
  readonly budgets?: ResearchBudgets;
}

/** One research turn as the runner hands it over: the tools and the CLI's model. */
export type TurnInput = ResearchInput & {
  readonly tools: ResearchToolsPort;
  /** The `--model` of the fast (or only) pass; undefined: the CLI's own. */
  readonly model?: string;
};

/** One CLI run of a turn: the first pass, or the deep pass after an escalation. */
export type CliPassInput = TurnInput & {
  /** The fast pass may answer with the escalation marker (its prompt says how). */
  readonly canDeepen: boolean;
  /** What the fast pass found, told to the deep pass. */
  readonly findings?: string;
};

interface TurnState {
  model: string;
  steps: number;
  /** Sources already streamed: a sources event goes out only when the list grows. */
  sourcesSent: number;
  sources: AnswerSource[];
  result: CliLine['result'];
  /** Why the fast pass must go deeper; null while it answered. */
  deepen: string | null;
}

function finalEvent(
  state: TurnState,
  { aborted, escalated }: { aborted: boolean; escalated: boolean },
): ResearchEvent {
  if (aborted || state.result?.ok)
    return {
      type: 'done',
      // Covered by the subscription: no spend entry, no cap (KBC-007 BR-2).
      usd: 0,
      billing: 'subscription',
      model: state.model,
      interrupted: aborted,
      steps: state.steps,
      ...(escalated ? { escalated: true } : {}),
    };
  return {
    type: 'error',
    code: state.result?.code ?? 'PROVIDER_UNAVAILABLE',
  };
}

interface CliTurnSetup {
  readonly dialect: CliDialect;
  readonly model: string;
  /** Shared by both passes, so segment numbers never repeat in one turn. */
  readonly answer: AnswerStream;
  readonly canDeepen: boolean;
  /** What the reader asked: what a give-up answer would deny. */
  readonly question: string;
}

/** The live state of one CLI pass: its events, the CLI's verdict and the steps taken. */
class CliTurn {
  readonly queue = new EventQueue<ResearchEvent>();
  readonly state: TurnState;

  constructor(private readonly setup: CliTurnSetup) {
    this.state = {
      model: setup.model,
      steps: 0,
      sourcesSent: 0,
      sources: [],
      result: undefined,
      deepen: null,
    };
  }

  onToolResult({ steps, sources }: ResearchToolResult): void {
    this.push(this.setup.answer.toolCalled());
    this.state.steps += 1;
    for (const step of steps) this.queue.push({ type: 'step', step });
    if (sources.length === this.state.sourcesSent) return;
    this.state.sourcesSent = sources.length;
    this.state.sources = [...sources];
    this.queue.push({ type: 'sources', sources: [...sources] });
  }

  async read(cli: CliProcess): Promise<void> {
    for await (const line of cli.lines) if (line.trim()) this.apply(line);
    await cli.exit;
  }

  finish(): void {
    this.endAnswer();
    this.queue.end();
  }

  /** The message ended without tools: the answer, or the fast pass asking to go deeper. */
  private endAnswer(): void {
    const { answer, canDeepen } = this.setup;
    const { question } = this.setup;
    const reason = canDeepen ? deepenReason(answer.current, question) : null;
    if (reason !== null && this.state.deepen === null) {
      this.state.deepen = reason;
      this.push(answer.toolCalled());
      return;
    }
    this.push(answer.ended());
  }

  private apply(line: string): void {
    const parsed = this.setup.dialect.parse(line);
    const { answer } = this.setup;
    if (parsed.model) this.state.model = parsed.model;
    if (parsed.result) this.state.result = parsed.result;
    for (const delegate of parsed.delegates ?? [])
      this.queue.push({
        type: 'step',
        step: { kind: 'delegate', text: `Delegando: ${delegate}` },
      });
    if (parsed.text) this.push(answer.text(parsed.text));
    if (parsed.messageEnd === 'tool_use') this.push(answer.toolCalled());
    if (parsed.messageEnd === 'answer') this.endAnswer();
  }

  private push(events: readonly ResearchEvent[]): void {
    for (const event of events) this.queue.push(event);
  }
}

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
  call: { readonly input: CliPassInput; readonly access: TurnAccess },
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
  { input, turn, maxSteps }: OpenPass,
) {
  const endpoint = options.turns.open(
    input.tools,
    { onResult: (result) => turn.onToolResult(result) },
    maxSteps,
  );
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

interface OpenPass {
  readonly input: CliPassInput;
  readonly turn: CliTurn;
  readonly maxSteps: number;
}

/** One CLI run: its endpoint and process live only while its events are read. */
async function* runPass(
  options: CliTurnOptions,
  dialect: CliDialect,
  pass: Omit<OpenPass, 'turn'> & { readonly answer: AnswerStream },
): AsyncGenerator<ResearchEvent, TurnState> {
  const { input } = pass;
  const { canDeepen, question } = input;
  const model = input.model ?? options.model;
  const turn = new CliTurn({ ...pass, dialect, model, canDeepen, question });
  const opened = { ...pass, turn };
  const { cli, endpoint, close } = await openTurn(options, dialect, opened);
  const unwatch = stopOnAbort(input.signal, () => {
    endpoint.close();
    cli.kill();
  });
  void turn
    .read(cli)
    .catch(() => undefined)
    .then(() => turn.finish());
  try {
    yield* turn.queue;
  } finally {
    unwatch();
    close();
  }
  return turn.state;
}

/** Runs `stop` when the reader aborts, at once if already aborted; returns the way to stop watching. */
export function stopOnAbort(signal: AbortSignal, stop: () => void): () => void {
  if (signal.aborted) {
    stop();
    return () => undefined;
  }
  signal.addEventListener('abort', stop, { once: true });
  return () => signal.removeEventListener('abort', stop);
}

/** The deep pass of an escalated turn: the deep model, told what the fast pass found. */
function deepPass(
  input: TurnInput,
  fast: TurnState,
  {
    escalation,
    budgets,
  }: { escalation: Escalation<string | undefined>; budgets: ResearchBudgets },
): Omit<OpenPass, 'turn'> {
  const findings = findingsText({ sources: fast.sources });
  return {
    input: {
      ...input,
      profile: 'deep',
      model: escalation.deep,
      canDeepen: false,
      findings,
    },
    maxSteps: Math.max(1, budgets.deep.steps - fast.steps),
  };
}

/** The deep model a fast turn may hand over to, when Settings allow it. */
function escalationOf(
  options: CliTurnOptions,
  input: TurnInput,
): Escalation<string | undefined> | undefined {
  const allowed = input.profile === 'fast' && options.escalation?.enabled();
  return allowed ? options.escalation : undefined;
}

/**
 * One research turn run by a subscription CLI (KBC-007 FR-4): the tools are served to it
 * over the turn's MCP endpoint, its stdout becomes tokens, and each tool call it makes
 * becomes a step and a sources event. Aborting closes the endpoint at once and kills the
 * CLI's process group (SIGTERM, then SIGKILL). A fast pass that could not settle the
 * question escalates: a second CLI run with the deep model, the same tools and numbering,
 * and the rest of the deep step budget (ADR 0009).
 */
/** The turn endpoint's tool calls: sub-agents reach it too, so theirs count (ADR 0014). */
const stepCap = (budgets: ResearchBudgets, input: TurnInput): number => {
  const budget = budgets[input.profile];
  return budget.steps + (budget.delegation?.totalSteps ?? 0);
};

export async function* runCliTurn(
  options: CliTurnOptions,
  dialect: CliDialect,
  input: TurnInput,
): AsyncIterable<ResearchEvent> {
  const answer = new AnswerStream();
  const budgets = options.budgets ?? DEFAULT_BUDGETS;
  const escalation = escalationOf(options, input);
  const first = { ...input, canDeepen: escalation !== undefined };
  const fast = yield* runPass(options, dialect, {
    input: first,
    maxSteps: stepCap(budgets, input),
    answer,
  });
  const aborted = input.signal.aborted;
  if (!escalation || fast.deepen === null || aborted || !fast.result?.ok) {
    yield finalEvent(fast, { aborted, escalated: false });
    return;
  }
  yield { type: 'step', step: DEEPEN_STEP };
  // The reader may stop right on "Aprofundando…": then the deep CLI never starts.
  if (input.signal.aborted) {
    yield finalEvent(fast, { aborted: true, escalated: true });
    return;
  }
  const pass = deepPass(input, fast, { escalation, budgets });
  const deep = yield* runPass(options, dialect, { ...pass, answer });
  const total = { ...deep, steps: fast.steps + deep.steps };
  yield finalEvent(total, { aborted: input.signal.aborted, escalated: true });
}
