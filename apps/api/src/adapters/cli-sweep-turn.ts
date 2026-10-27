import type { AiTestCode, ResearchEvent, SweepPlan } from '@kb-chat/contracts';
import {
  AnswerStream,
  CoverageLineFilter,
  DEFAULT_BUDGETS,
  NO_TOOLS,
  PLAN_STEPS,
  PlanningTools,
  SUBSCRIPTION_CONTEXT_TOKENS,
  SweepFatalError,
  TurnResearchTools,
  runSweepTurn,
  sweepTurnHost,
  type BatchEngine,
  type SweepKit,
  type SweepTurnResult,
} from '../modules/research/index.js';
import type { AgentMessage } from '../ports/llm.js';
import {
  runPass,
  stopOnAbort,
  type CliDialect,
  type CliPassState,
  type CliTurnOptions,
  type PassOutput,
  type TurnInput,
} from './cli-research-turn.js';
import { subscriptionTurnInput } from './subscription-prompt.js';

/** Claude Code runs a few batches at once; Codex runs one turn at a time (ADR 0020). */
const PARALLEL: Readonly<Record<string, number>> = { claude: 3, codex: 1 };

/** A CLI failure that is the provider's capacity (usage limits): the sweep waits, then stops. */
const CAPACITY_CODES: ReadonlySet<AiTestCode> = new Set([
  'PROVIDER_UNAVAILABLE',
]);

interface SweepState {
  model: string;
  steps: number;
}

/** A CLI that did not answer: a login or a missing CLI ends the turn, a busy one is retried. */
function cliFailure(code: AiTestCode | undefined): Error {
  const known = code ?? 'PROVIDER_UNAVAILABLE';
  return CAPACITY_CODES.has(known)
    ? new Error(`CLI unavailable: ${known}`)
    : new SweepFatalError(known);
}

/** Runs one pass to its end, streaming its events; returns what it ended with. */
async function* drained(
  pass: AsyncGenerator<ResearchEvent, CliPassState>,
): AsyncGenerator<ResearchEvent, CliPassState> {
  return yield* pass;
}

/** One pass whose events are dropped (a batch): only its collected text matters. */
async function quiet(
  pass: AsyncGenerator<ResearchEvent, CliPassState>,
): Promise<CliPassState> {
  for (;;) {
    const next = await pass.next();
    if (next.done) return next.value;
  }
}

/**
 * Planning on the CLI (KBC-030, ADR 0021): the research tools and plan_sweep over the turn's
 * MCP endpoint; the CLI's text never reaches the reader. The pass ends as soon as the plan
 * is in; without one (a lazy answer, the steps spent), the default plan applies.
 */
async function* planWithCli(
  options: CliTurnOptions,
  dialect: CliDialect,
  { input, state, kit }: { input: TurnInput; state: SweepState; kit: SweepKit },
): AsyncGenerator<ResearchEvent, SweepPlan> {
  const planned = new AbortController();
  const unwatch = stopOnAbort(input.signal, () => planned.abort());
  const tools = new PlanningTools(input.tools, () => planned.abort());
  try {
    const pass = runPass(options, dialect, {
      input: { ...input, tools, signal: planned.signal, canDeepen: false },
      // The plan_sweep call itself is one more step.
      maxSteps: Math.min(PLAN_STEPS, planSteps(options)) + 1,
      answer: new AnswerStream(),
      output: { collect: () => undefined },
    });
    const ended = yield* drained(pass);
    state.model = ended.model;
    state.steps += ended.steps;
    if (tools.plan) return tools.plan;
    if (!input.signal.aborted && ended.result && !ended.result.ok)
      throw cliFailure(ended.result.code);
    return kit.sweeps.defaultPlan(input.topic, input.question);
  } finally {
    unwatch();
  }
}

/** KB_CHAT_EXHAUSTIVE_STEPS can lower the planning steps, never raise them. */
const planSteps = (options: CliTurnOptions): number =>
  (options.budgets ?? DEFAULT_BUDGETS).exhaustive.steps;

/** Each batch is its own CLI run, without tools (ADR 0021). */
function cliEngine(
  options: CliTurnOptions,
  dialect: CliDialect,
  input: TurnInput,
): BatchEngine {
  return {
    free: false,
    parallel: PARALLEL[dialect.name] ?? 1,
    extract: async ({ system, user, signal }) => {
      let text = '';
      const output: PassOutput = { collect: (part) => (text += part) };
      const ended = await quiet(
        runPass(options, dialect, {
          input: { ...input, ...callInput(system, user), signal },
          maxSteps: 0,
          answer: new AnswerStream(),
          output,
        }),
      );
      if (!signal.aborted && !ended.result?.ok)
        throw cliFailure(ended.result?.code);
      return text;
    },
  };
}

const callInput = (system: string, user: string) => ({
  tools: NO_TOOLS,
  canDeepen: false,
  override: { system, input: user },
});

/** The answer from the findings: one more CLI run, streamed, the model's coverage line out. */
async function* answerWithCli(
  call: CliCallContext,
  { messages, answer }: { messages: AgentMessage[]; answer: AnswerStream },
): AsyncIterable<ResearchEvent> {
  const system = messages[0]?.content ?? '';
  const last = messages.at(-1)?.content ?? call.input.question;
  const user = subscriptionTurnInput(last, call.input.history);
  const ended = yield* drained(
    runPass(call.options, call.dialect, {
      input: { ...call.input, ...callInput(system, user) },
      maxSteps: 0,
      answer,
      output: { filter: new CoverageLineFilter() },
    }),
  );
  if (!call.input.signal.aborted && !ended.result?.ok)
    throw cliFailure(ended.result?.code);
}

function doneEvent(
  state: SweepState,
  { aborted, sweep }: { aborted: boolean; sweep: SweepTurnResult | null },
): ResearchEvent {
  return {
    type: 'done',
    usd: 0,
    billing: 'subscription',
    model: state.model,
    interrupted: aborted,
    steps: state.steps,
    ...(sweep && { coverage: sweep.coverage }),
    ...(sweep?.cursor && { sweep: sweep.cursor }),
  };
}

/**
 * An exhaustive turn on a subscription CLI (KBC-030, ADR 0021): the CLI plans over MCP, then
 * the app sweeps with one CLI run per batch and asks one last run for the answer from the
 * findings, like the in-API loop does with a per-token model. Codex stays in its sandbox:
 * every run goes through the same runner with the same arguments (ADR 0020).
 */
export async function* runCliSweepTurn(
  options: CliTurnOptions,
  dialect: CliDialect,
  input: TurnInput,
): AsyncIterable<ResearchEvent> {
  // The sweep needs the turn's own tools (their numbering); a stand-in has none.
  const kit =
    input.tools instanceof TurnResearchTools ? input.tools.sweepKit : null;
  if (!kit) {
    yield { type: 'error', code: 'INTERNAL' };
    return;
  }
  const call: CliCallContext = { options, dialect, input };
  const startedAt = Date.now();
  const state: SweepState = { model: input.model ?? options.model, steps: 0 };
  try {
    const sweep = yield* planAndSweep(call, { kit, state, startedAt });
    yield doneEvent(state, { aborted: input.signal.aborted, sweep });
  } catch (err) {
    yield input.signal.aborted
      ? doneEvent(state, { aborted: true, sweep: null })
      : { type: 'error', code: errorCode(err) };
  }
}

interface CliCallContext {
  readonly options: CliTurnOptions;
  readonly dialect: CliDialect;
  readonly input: TurnInput;
}

const errorCode = (err: unknown): string =>
  err instanceof SweepFatalError ? err.code : 'PROVIDER_UNAVAILABLE';

/** The plan (the cursor's, or one the CLI makes), then the sweep and its answer. */
async function* planAndSweep(
  call: CliCallContext,
  {
    kit,
    state,
    startedAt,
  }: { kit: SweepKit; state: SweepState; startedAt: number },
): AsyncGenerator<ResearchEvent, SweepTurnResult | null> {
  const { options, dialect, input } = call;
  const plan =
    input.sweep?.plan ??
    (yield* planWithCli(options, dialect, { input, state, kit }));
  if (input.signal.aborted) return null;
  return yield* runSweepTurn(sweepHost(call, { kit, startedAt }), plan);
}

function sweepHost(
  call: CliCallContext,
  { kit, startedAt }: { kit: SweepKit; startedAt: number },
) {
  const { options, dialect, input } = call;
  const answer = new AnswerStream();
  return sweepTurnHost({
    kit,
    input,
    engine: cliEngine(options, dialect, input),
    contextTokens: SUBSCRIPTION_CONTEXT_TOKENS,
    budget: (options.budgets ?? DEFAULT_BUDGETS).exhaustive,
    startedAt,
    requestsBefore: input.sweep ? 0 : 1,
    answer: (messages: AgentMessage[]) =>
      answerWithCli(call, { messages, answer }),
  });
}
