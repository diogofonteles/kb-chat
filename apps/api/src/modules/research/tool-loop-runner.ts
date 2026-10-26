import type { ResearchBilling, ResearchEvent } from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import {
  LlmCapacityError,
  LlmKeyRejectedError,
} from '../../ports/llm-errors.js';
import type {
  AgentChunk,
  AgentLlmPort,
  AgentMessage,
  LlmUsage,
  ToolCall,
} from '../../ports/llm.js';
import type {
  ResearchInput,
  ResearchRunnerPort,
} from '../../ports/research-runner.js';
import { tokensOf, type SpendService } from '../spend/index.js';
import {
  EMPTY_ANSWER,
  FINAL_ANSWER_NOTE,
  FINAL_DEEPEN_NOTE,
  buildResearchMessages,
  researchSystemPrompt,
} from './prompt.js';
import { AnswerStream } from './answer-stream.js';
import {
  DEEPEN_STEP,
  deepenNote,
  deepenReason,
  beforeMarker,
} from './escalation.js';
import { KEEP_TOOL_RESULTS, compactToolResults } from './compaction.js';
import {
  DEFAULT_BUDGETS,
  DELEGATION,
  type DelegationBudget,
  type ProfileBudget,
  type ResearchBudgets,
} from './limits.js';
import {
  DELEGATE_DEFINITION,
  DELEGATE_TOOL,
  delegateArgsSchema,
} from './delegate.js';
import { EventPipe } from './event-pipe.js';
import { SourceBook } from './source-book.js';
import {
  Slots,
  delegateSteps,
  runAll,
  numberTasks,
  promptText,
  reportsText,
  runSubAgent,
  type SubAgentHost,
  type SubTask,
} from './subagents.js';
import { failed, parsedArgs, type PreparedCall } from './tool-context.js';
import type { ResearchTools } from './tools.js';

/** The "answer now" notes of a spent budget: dropped when the deep model takes over. */
const FINAL_NOTES: ReadonlySet<string> = new Set([
  FINAL_ANSWER_NOTE,
  FINAL_DEEPEN_NOTE,
]);

/** What a turn still above the threshold keeps whole, after the first compaction. */
const MIN_KEPT_RESULTS = 2;

const SKIPPED_CALL =
  'Não executada: o limite de passos desta resposta foi atingido.';

/** A model and the spend service that prices it. */
export interface LoopEngine {
  readonly llm: AgentLlmPort;
  readonly spend: SpendService;
}

export interface ToolLoopRunnerDeps extends LoopEngine {
  readonly tools: ResearchTools;
  /** The deep profile's model, for a fast turn that escalates (ADR 0009). */
  readonly deep?: LoopEngine;
  /** Whether a fast turn may escalate (Settings, "Aprofundar automaticamente"). */
  readonly autoDeepen?: () => boolean;
  /** Steps, output, ceilings and compaction per profile (ADR 0013); default DEFAULT_BUDGETS. */
  readonly budgets?: ResearchBudgets;
}

interface Turn {
  readonly input: ResearchInput;
  readonly topicTitle: string;
  readonly book: SourceBook;
  readonly messages: AgentMessage[];
  readonly answer: AnswerStream;
  /** The model answering now: the fast one, then the deep one after an escalation. */
  engine: LoopEngine;
  /** The step budget: the profile's, then the deep one's after an escalation (KBC-011). */
  maxSteps: number;
  /** The profile's output, ceilings and compaction (the deep one's after an escalation). */
  budget: ProfileBudget;
  /** When the research must stop and answer (exhaustive profile), in ms since the epoch. */
  readonly deadline: number | null;
  /** The deep profile still to hand over to, while the turn may escalate. */
  deepen: LoopEngine | null;
  escalated: boolean;
  steps: number;
  /** Sub-researchers numbered so far and the tool steps they took (ADR 0014). */
  agents: number;
  subSteps: number;
  /** At most `parallel` sub-researchers at once, across the turn's delegate calls. */
  readonly slots: Slots | null;
  /** Estimates of sub-researcher calls in flight, counted by the spend guard. */
  reservedUsd: number;
  /** Serializes the sub-researchers' check-and-reserve, so none sees a stale reservation. */
  spendQueue: Promise<unknown>;
  sourcesSent: number;
  /** The model that wrote the last call, when the provider names it (KBC-022). */
  servedModel: string | null;
  /** What each model spent; an escalated turn has two (one ledger entry each). */
  readonly spent: Map<LoopEngine, Spent>;
  usd: number;
}

interface Spent {
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

interface CallResult {
  /** Everything the model wrote, kept in its context even when it was not the answer. */
  text: string;
  readonly toolCalls: ToolCall[];
  usage: LlmUsage | null;
}

/** A key the provider refused is the reader's to fix in Settings (KBC-007). */
function errorCode(err: unknown): string {
  if (err instanceof AppError) return err.code;
  if (err instanceof LlmCapacityError) return 'AI_CAPACITY_EXHAUSTED';
  return err instanceof LlmKeyRejectedError ? 'LLM_KEY_REJECTED' : 'INTERNAL';
}

type Done = Extract<ResearchEvent, { type: 'done' }>;

/** A free model of OpenRouter (`:free`, the free router), as named in its answer. */
const isFreeModel = (model: string | null): boolean =>
  model !== null && (model.endsWith(':free') || model === 'openrouter/free');

/** "Gratuito" when a per-token turn cost nothing on a free model (KBC-023 BR-7). */
function billingOf(turn: Turn): ResearchBilling {
  const billing = turn.engine.llm.billing;
  return billing === 'per-token' &&
    turn.usd === 0 &&
    isFreeModel(turn.servedModel)
    ? 'free'
    : billing;
}

/** When a turn with this budget must answer, in ms since the epoch; null: no ceiling. */
const deadlineOf = (budget: ProfileBudget): number | null =>
  budget.maxMinutes === null ? null : Date.now() + budget.maxMinutes * 60_000;

/** Grants sub-researcher tool steps from the turn's total (ADR 0014). */
function reserveSubSteps(
  turn: Turn,
  { budget, wanted }: { budget: DelegationBudget; wanted: number },
): number {
  const granted = Math.max(
    0,
    Math.min(wanted, budget.totalSteps - turn.subSteps),
  );
  turn.subSteps += granted;
  return granted;
}

function parseJson(raw: string): unknown {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}

/**
 * The research agent's loop in the API (ADR 0006): the model searches, reads and follows
 * relations through the tools, up to the profile's step budget (ADR 0009), then answers.
 * Text streams at once and is retracted when its call asks for tools (AnswerStream). The
 * spend is guarded before every model call and recorded once per turn.
 */
export class ToolLoopRunner implements ResearchRunnerPort {
  constructor(private readonly deps: ToolLoopRunnerDeps) {}

  get model(): string {
    return this.deps.llm.model;
  }

  get billing(): ResearchBilling {
    return this.deps.llm.billing;
  }

  configured(): boolean {
    return this.deps.llm.configured();
  }

  async *run(input: ResearchInput): AsyncIterable<ResearchEvent> {
    const topicTitle = this.deps.tools.topicTitle(input.topic);
    if (topicTitle === null) {
      yield { type: 'error', code: 'TOPIC_NOT_FOUND' };
      return;
    }
    const turn = this.startTurn(input, topicTitle);
    // find_text needs the topic's folded text; build it while the model thinks.
    void this.deps.tools.warm(input.topic).catch(() => undefined);
    try {
      yield* this.loop(turn);
    } catch (err) {
      if (!input.signal.aborted) {
        await this.record(turn, true);
        yield { type: 'error', code: errorCode(err) };
        return;
      }
    }
    yield await this.record(turn, input.signal.aborted);
  }

  private get budgets(): ResearchBudgets {
    return this.deps.budgets ?? DEFAULT_BUDGETS;
  }

  private startTurn(input: ResearchInput, topicTitle: string): Turn {
    const budget = this.budgets[input.profile];
    const canDeepen =
      input.profile === 'fast' &&
      this.deps.deep !== undefined &&
      (this.deps.autoDeepen?.() ?? true);
    return {
      input,
      topicTitle,
      book: new SourceBook(),
      messages: buildResearchMessages({ ...input, topicTitle, canDeepen }),
      answer: new AnswerStream(),
      engine: this.deps,
      deepen: canDeepen ? (this.deps.deep ?? null) : null,
      escalated: false,
      maxSteps: budget.steps,
      budget,
      deadline: deadlineOf(budget),
      steps: 0,
      agents: 0,
      subSteps: 0,
      slots: budget.delegation ? new Slots(budget.delegation.parallel) : null,
      reservedUsd: 0,
      spendQueue: Promise.resolve(),
      sourcesSent: 0,
      servedModel: null,
      spent: new Map(),
      usd: 0,
    };
  }

  private async *loop(turn: Turn): AsyncIterable<ResearchEvent> {
    for (;;) {
      if (turn.input.signal.aborted) return;
      const final = this.mustAnswer(turn);
      this.compact(turn);
      if (final)
        turn.messages.push({
          role: 'system',
          content: turn.deepen ? FINAL_DEEPEN_NOTE : FINAL_ANSWER_NOTE,
        });
      await this.guard(turn, final);
      const call = yield* this.callModel(turn, final);
      if (yield* this.afterCall(turn, call, final)) return;
    }
  }

  /** Runs the tools a call asked for, or ends (or escalates) on an answer; true when done. */
  private async *afterCall(
    turn: Turn,
    call: CallResult,
    final: boolean,
  ): AsyncGenerator<ResearchEvent, boolean> {
    if (!final && call.toolCalls.length > 0) {
      yield* this.runTools(turn, call);
      return false;
    }
    if (yield* this.escalate(turn, call)) return false;
    yield* turn.answer.ended();
    yield* this.ensureAnswer(turn);
    return true;
  }

  /**
   * A fast answer that could not settle the question (the marker, or an answer that gives
   * up on the collection) is taken back and the same turn goes on with the deep model, its
   * prompt and the rest of the deep step budget, keeping every tool result (ADR 0009).
   */
  private async *escalate(
    turn: Turn,
    call: CallResult,
  ): AsyncGenerator<ResearchEvent, boolean> {
    const reason = deepenReason(turn.answer.current, turn.input.question);
    const deep = turn.deepen;
    if (!deep || reason === null || turn.input.signal.aborted) return false;
    yield* turn.answer.toolCalled();
    yield { type: 'step', step: DEEPEN_STEP };
    turn.deepen = null;
    turn.escalated = true;
    turn.engine = deep;
    turn.budget = this.budgets.deep;
    turn.maxSteps = turn.budget.steps;
    this.handOver(turn, call, reason);
    return true;
  }

  /**
   * The deep model's conversation: its own prompt, no "answer now" note of the fast pass,
   * the fast text without the marker, and the hand-over note as a user turn, so the request
   * never ends on an assistant turn (a prefill, refused by current models).
   */
  private handOver(turn: Turn, call: CallResult, reason: string): void {
    const prompt = researchSystemPrompt(turn.topicTitle, 'deep');
    const kept = turn.messages.filter(
      (m, i) => i > 0 && !(m.role === 'system' && FINAL_NOTES.has(m.content)),
    );
    const said = beforeMarker(call.text).trim();
    const note = deepenNote(reason, turn.maxSteps - turn.steps);
    turn.messages.splice(
      0,
      turn.messages.length,
      { role: 'system', content: prompt },
      ...kept,
      ...(said
        ? [{ role: 'assistant' as const, content: said, toolCalls: [] }]
        : []),
      { role: 'user', content: note },
    );
  }

  /** The step budget or the wall-clock ceiling is spent: the next call answers. */
  private mustAnswer(turn: Turn): boolean {
    if (turn.steps >= turn.maxSteps) return true;
    return turn.deadline !== null && Date.now() >= turn.deadline;
  }

  /**
   * Auto-compaction (ADR 0013): past the profile's threshold, old tool results become a
   * short ledger so a long exhaustive turn never overflows the model's context.
   */
  private compact(turn: Turn): void {
    const threshold = turn.budget.compactTokens;
    if (threshold === null) return;
    for (const keep of [KEEP_TOOL_RESULTS, MIN_KEPT_RESULTS]) {
      if (tokensOf(promptText(turn.messages)) <= threshold) return;
      const { messages } = compactToolResults(turn.messages, {
        book: turn.book,
        keep,
      });
      turn.messages.splice(0, turn.messages.length, ...messages);
    }
  }

  /**
   * Daily cap and credit before every model call, counting what this turn already spent.
   * The forced last call is priced at its whole output budget: the long answer comes then.
   */
  private guard(turn: Turn, final: boolean): Promise<void> {
    const { guardOutputTokens, outputTokens } = turn.budget;
    return this.guardSpend(turn, {
      prompt: promptText(turn.messages),
      outputTokens: final ? outputTokens : guardOutputTokens,
    });
  }

  /** One call's estimate against the cap, with what the whole turn (sub-researchers too) spent. */
  private async guardSpend(
    turn: Turn,
    { prompt, outputTokens }: { prompt: string; outputTokens: number },
  ): Promise<void> {
    const { llm, spend } = turn.engine;
    const estimate = await spend.estimate(
      prompt,
      llm.maxOutputTokens(outputTokens),
    );
    await spend.guard(turn.usd + turn.reservedUsd + estimate);
  }

  /**
   * A sub-researcher's guard: like guardSpend, and the estimate stays reserved until
   * accounted. Checks run one after the other, so parallel calls each see the others'.
   */
  private reserveSpend(
    turn: Turn,
    prompt: string,
    outputTokens: number,
  ): Promise<number> {
    const reserved = turn.spendQueue.then(() =>
      this.checkAndReserve(turn, prompt, outputTokens),
    );
    turn.spendQueue = reserved.catch(() => undefined);
    return reserved;
  }

  private async checkAndReserve(
    turn: Turn,
    prompt: string,
    outputTokens: number,
  ): Promise<number> {
    const { llm, spend } = turn.engine;
    const estimate = await spend.estimate(
      prompt,
      llm.maxOutputTokens(outputTokens),
    );
    await spend.guard(turn.usd + turn.reservedUsd + estimate);
    turn.reservedUsd += estimate;
    return estimate;
  }

  private async *callModel(
    turn: Turn,
    final: boolean,
  ): AsyncGenerator<ResearchEvent, CallResult> {
    const call: CallResult = { text: '', toolCalls: [], usage: null };
    const prompt = promptText(turn.messages);
    try {
      yield* this.consume(turn, call, final);
    } catch (err) {
      if (!turn.input.signal.aborted) throw err;
    } finally {
      await this.account(turn, call, prompt);
    }
    return call;
  }

  private async *consume(
    turn: Turn,
    call: CallResult,
    final: boolean,
  ): AsyncIterable<ResearchEvent> {
    const chunks = turn.engine.llm.streamAgent(
      turn.messages,
      this.definitions(turn),
      {
        maxTokens: turn.budget.outputTokens,
        signal: turn.input.signal,
        toolChoice: final ? 'none' : 'auto',
      },
    );
    for await (const chunk of chunks)
      yield* this.take(turn, call, { chunk, final });
  }

  /**
   * One chunk of a model call: text streams at once (AnswerStream); a tool call retracts
   * what the call already showed. The forced last call ignores tool calls.
   */
  private *take(
    turn: Turn,
    call: CallResult,
    { chunk, final }: { chunk: AgentChunk; final: boolean },
  ): Iterable<ResearchEvent> {
    if (chunk.type === 'usage') call.usage = chunk.usage;
    else if (chunk.type === 'tool_call') {
      if (final) return;
      call.toolCalls.push(chunk.call);
      yield* turn.answer.toolCalled();
    } else {
      call.text += chunk.text;
      // Text after a tool call in the same call is the model's, not the reader's.
      if (call.toolCalls.length === 0) yield* turn.answer.text(chunk.text);
    }
  }

  private async *ensureAnswer(turn: Turn): AsyncIterable<ResearchEvent> {
    if (turn.answer.shown.trim() || turn.input.signal.aborted) return;
    yield* turn.answer.say(EMPTY_ANSWER);
  }

  private async *runTools(
    turn: Turn,
    call: CallResult,
  ): AsyncIterable<ResearchEvent> {
    const runnable = call.toolCalls.slice(0, turn.maxSteps - turn.steps);
    // Sub-researchers stream their steps while the calls run (ADR 0014).
    const pipe = new EventPipe<ResearchEvent>();
    const prepared = runnable.map((c) => this.prepare(turn, c, pipe));
    for (const { steps } of prepared)
      for (const step of steps) yield { type: 'step', step };
    const running = Promise.all(prepared.map((p) => p.run())).finally(() =>
      pipe.end(),
    );
    // Handled below, after the pipe drains; this only keeps Node from calling it unhandled.
    running.catch(() => undefined);
    yield* pipe;
    const outputs = await running;
    turn.steps += runnable.length;
    turn.messages.push(
      { role: 'assistant', content: call.text, toolCalls: call.toolCalls },
      ...call.toolCalls.map((c, i) => ({
        role: 'tool' as const,
        toolCallId: c.id,
        content: outputs[i] ?? SKIPPED_CALL,
      })),
    );
    if (turn.book.size === turn.sourcesSent) return;
    turn.sourcesSent = turn.book.size;
    yield { type: 'sources', sources: turn.book.list() };
  }

  /** The tools of this turn: the exhaustive orchestrator may also delegate (ADR 0014). */
  private definitions(turn: Turn) {
    return turn.budget.delegation
      ? [...this.deps.tools.definitions, DELEGATE_DEFINITION]
      : this.deps.tools.definitions;
  }

  private prepare(
    turn: Turn,
    call: ToolCall,
    pipe: EventPipe<ResearchEvent>,
  ): PreparedCall {
    if (call.name !== DELEGATE_TOOL || !turn.budget.delegation)
      return this.deps.tools.prepare(call, {
        topic: turn.input.topic,
        book: turn.book,
      });
    const args = parsedArgs(delegateArgsSchema, parseJson(call.arguments));
    if (typeof args === 'string') return failed(args);
    const tasks = numberTasks(args, turn.agents + 1);
    turn.agents += tasks.length;
    return {
      steps: delegateSteps(tasks),
      run: () => this.delegate(turn, { tasks, pipe }),
    };
  }

  /**
   * Runs the tasks on sub-researchers, a few at a time, and returns their reports. A
   * failure (the daily cap) stops the others; the reader's stop reaches them all.
   */
  private async delegate(
    turn: Turn,
    {
      tasks,
      pipe,
    }: { tasks: readonly SubTask[]; pipe: EventPipe<ResearchEvent> },
  ): Promise<string> {
    const abort = new AbortController();
    const stop = () => abort.abort();
    turn.input.signal.addEventListener('abort', stop, { once: true });
    if (turn.input.signal.aborted) stop();
    const host = this.subHost(turn, { signal: abort.signal, pipe });
    const slots = turn.slots ?? new Slots(host.budget.parallel);
    try {
      const results = await runAll(tasks, { slots, onFailure: stop }, (task) =>
        runSubAgent(host, task),
      );
      return reportsText(
        tasks,
        results.map((r) => r.report),
      );
    } finally {
      turn.input.signal.removeEventListener('abort', stop);
    }
  }

  /** What a sub-researcher borrows from the turn: its model, tools, numbering and spend. */
  private subHost(
    turn: Turn,
    { signal, pipe }: { signal: AbortSignal; pipe: EventPipe<ResearchEvent> },
  ): SubAgentHost {
    const budget = turn.budget.delegation ?? DELEGATION;
    const { llm } = turn.engine;
    return {
      llm,
      tools: this.deps.tools,
      context: { topic: turn.input.topic, book: turn.book },
      topicTitle: turn.topicTitle,
      budget,
      compactTokens: turn.budget.compactTokens,
      signal,
      deadline: turn.deadline,
      guard: (prompt, outputTokens) =>
        this.reserveSpend(turn, prompt, outputTokens),
      account: (call, cost) => this.accountReserved(turn, call, cost),
      release: (reserved) => {
        turn.reservedUsd -= reserved;
      },
      remainingSteps: () => budget.totalSteps - turn.subSteps,
      reserveSteps: (wanted) => reserveSubSteps(turn, { budget, wanted }),
      emit: (event) => pipe.push(event),
    };
  }

  /** A sub-researcher's cost: its reservation is freed only once the real cost is in (BR-4). */
  private async accountReserved(
    turn: Turn,
    call: CallResult,
    { prompt, reserved }: { prompt: string; reserved: number },
  ): Promise<void> {
    try {
      await this.account(turn, call, prompt);
    } finally {
      turn.reservedUsd -= reserved;
    }
  }

  /** Real usage when reported; otherwise counted from the prompt and the output. */
  private async account(
    turn: Turn,
    call: CallResult,
    prompt: string,
  ): Promise<void> {
    const usage = call.usage ?? {
      inputTokens: tokensOf(prompt),
      outputTokens: tokensOf(
        call.text + call.toolCalls.map((c) => c.arguments).join(''),
      ),
      usd: null,
    };
    const usd = await turn.engine.spend.costOf(usage);
    const spent = turn.spent.get(turn.engine) ?? {
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
    };
    turn.spent.set(turn.engine, {
      inputTokens: spent.inputTokens + usage.inputTokens,
      outputTokens: spent.outputTokens + usage.outputTokens,
      usd: spent.usd + usd,
    });
    turn.usd += usd;
    if (usage.model) turn.servedModel = usage.model;
  }

  /** One ledger entry per model of the turn (nothing spent, nothing recorded). */
  private async record(turn: Turn, interrupted: boolean): Promise<Done> {
    // One entry per model, so an escalated turn charges each model its own share.
    for (const [engine, spent] of turn.spent)
      await engine.spend.record({
        inputTokens: spent.inputTokens,
        outputTokens: spent.outputTokens,
        usd: spent.usd,
        interrupted,
        ...(turn.servedModel && { model: turn.servedModel }),
      });
    return {
      type: 'done',
      usd: turn.usd,
      billing: billingOf(turn),
      model: turn.servedModel ?? turn.engine.llm.model,
      interrupted,
      steps: turn.steps + turn.subSteps,
      ...(turn.escalated ? { escalated: true } : {}),
    };
  }
}
