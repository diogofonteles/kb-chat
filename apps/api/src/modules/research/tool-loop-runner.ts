import {
  sweepPlanSchema,
  type ResearchBilling,
  type ResearchEvent,
  type SweepPlan,
} from '@kb-chat/contracts';
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
import { tokensForChars, tokensOf, type SpendService } from '../spend/index.js';
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
  SWEEP,
  type ProfileBudget,
  type ResearchBudgets,
  type SweepBudget,
} from './limits.js';
import { promptText } from './prompt-text.js';
import { SourceBook } from './source-book.js';
import { CoverageLineFilter } from './sweep/coverage-filter.js';
import {
  PLAN_STEPS,
  PLAN_SWEEP_DEFINITION,
  PLAN_SWEEP_TOOL,
} from './sweep/plan-tool.js';
import type { BatchEngine, SweepClock } from './sweep/sweep-coordinator.js';
import type { SweepPacer } from './sweep/sweep-pacing.js';
import {
  batchCharsFor,
  runSweepTurn,
  sweepTurnHost,
  type SweepTurnHost,
  type SweepTurnResult,
} from './sweep/sweep-turn.js';
import { sweepAnswerMessages } from './sweep/sweep-prompts.js';
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
  /** The sweep's clock (tests); default the real one. */
  readonly clock?: SweepClock;
  /** The free-model pacer (tests); default the process's. */
  readonly pacer?: SweepPacer;
}

interface Turn {
  readonly input: ResearchInput;
  readonly topicTitle: string;
  /** The collection's main author (KBC-049): the authorship rule names him. */
  readonly mainAuthor: string | null;
  readonly book: SourceBook;
  readonly messages: AgentMessage[];
  readonly answer: AnswerStream;
  /** The model answering now: the fast one, then the deep one after an escalation. */
  engine: LoopEngine;
  /** The step budget: the profile's, then the deep one's after an escalation (KBC-011). */
  maxSteps: number;
  /** The profile's output, ceilings and compaction (the deep one's after an escalation). */
  budget: ProfileBudget;
  /** When the turn started, in ms since the epoch (the sweep's ceiling counts from it). */
  readonly startedAt: number;
  /** When the research must stop and answer (exhaustive profile), in ms since the epoch. */
  readonly deadline: number | null;
  /** The deep profile still to hand over to, while the turn may escalate. */
  deepen: LoopEngine | null;
  escalated: boolean;
  steps: number;
  /** Model calls of the turn (the exhaustive sweep counts its requests, ADR 0021). */
  calls: number;
  /** The exhaustive plan, once the orchestrator called plan_sweep (KBC-030). */
  plan: SweepPlan | null;
  /** The exhaustive answer leaves out any coverage line the model writes. */
  filter: CoverageLineFilter | null;
  /** What the sweep covered, for `done`. */
  sweep: SweepTurnResult | null;
  /** Estimates of sweep batches in flight, counted by the spend guard. */
  reservedUsd: number;
  /** Kept free for the answer while the batches run: the sweep never spends it. */
  finalReserveUsd: number;
  /** Serializes the batches' check-and-reserve, so none sees a stale reservation. */
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

/** What a turn has done and spent when it starts: nothing. */
const freshCounters = () => ({
  steps: 0,
  calls: 0,
  plan: null,
  filter: null,
  sweep: null,
  reservedUsd: 0,
  finalReserveUsd: 0,
  spendQueue: Promise.resolve(),
  sourcesSent: 0,
  servedModel: null,
  spent: new Map<LoopEngine, Spent>(),
  usd: 0,
});

/** A call's text and usage, without tools (a sweep batch). */
async function collectCall(
  chunks: AsyncIterable<AgentChunk>,
  call: CallResult,
): Promise<void> {
  for await (const chunk of chunks)
    if (chunk.type === 'usage') call.usage = chunk.usage;
    else if (chunk.type === 'token') call.text += chunk.text;
}

/** When a turn with this budget must answer, in ms since the epoch; null: no ceiling. */
const deadlineOf = (budget: ProfileBudget): number | null =>
  budget.maxMinutes === null ? null : Date.now() + budget.maxMinutes * 60_000;

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

  /** A fast turn may hand over to the deep model (ADR 0009). */
  private canDeepen(input: ResearchInput): boolean {
    return (
      input.profile === 'fast' &&
      this.deps.deep !== undefined &&
      (this.deps.autoDeepen?.() ?? true)
    );
  }

  private get budgets(): ResearchBudgets {
    return this.deps.budgets ?? DEFAULT_BUDGETS;
  }

  private startTurn(input: ResearchInput, topicTitle: string): Turn {
    const budget = this.budgets[input.profile];
    const mainAuthor = this.deps.tools.mainAuthor(input.topic);
    const canDeepen = this.canDeepen(input);
    return {
      input,
      topicTitle,
      mainAuthor,
      book: new SourceBook(),
      messages: buildResearchMessages({
        ...input,
        topicTitle,
        mainAuthor,
        canDeepen,
      }),
      answer: new AnswerStream(),
      engine: this.deps,
      deepen: canDeepen ? (this.deps.deep ?? null) : null,
      escalated: false,
      // An exhaustive turn only plans with tools; the app sweeps (ADR 0021).
      maxSteps: budget.sweep
        ? Math.min(PLAN_STEPS, budget.steps)
        : budget.steps,
      budget,
      startedAt: Date.now(),
      deadline: deadlineOf(budget),
      ...freshCounters(),
    };
  }

  private async *loop(turn: Turn): AsyncIterable<ResearchEvent> {
    if (turn.budget.sweep) {
      yield* this.exhaustive(turn);
      return;
    }
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

  /**
   * The exhaustive turn (KBC-030, ADR 0021): the orchestrator plans (or the default plan
   * applies), then the app sweeps the whole set and only then asks for the answer.
   */
  private async *exhaustive(turn: Turn): AsyncIterable<ResearchEvent> {
    const plan = turn.input.sweep?.plan ?? (yield* this.planSweep(turn));
    if (turn.input.signal.aborted) return;
    turn.sweep = yield* runSweepTurn(await this.sweepHost(turn), plan);
  }

  /**
   * Planning: the research tools and plan_sweep, a few steps. An answer written before the
   * sweep (a lazy model) is taken back and the default plan applies, as when the steps run out.
   */
  private async *planSweep(
    turn: Turn,
  ): AsyncGenerator<ResearchEvent, SweepPlan> {
    const fallback = () =>
      this.deps.tools.sweeps.defaultPlan(turn.input.topic, turn.input.question);
    for (;;) {
      if (turn.input.signal.aborted || this.mustAnswer(turn)) return fallback();
      this.compact(turn);
      await this.guard(turn, false);
      const call = yield* this.callModel(turn, false);
      if (call.toolCalls.length === 0) {
        yield* turn.answer.toolCalled();
        return fallback();
      }
      yield* this.runTools(turn, call);
      if (turn.plan) return turn.plan;
    }
  }

  /** What the sweep borrows from the turn: tools, numbering, model, spend and ceilings. */
  private async sweepHost(turn: Turn): Promise<SweepTurnHost> {
    const { input, budget } = turn;
    const { llm } = turn.engine;
    return sweepTurnHost({
      kit: {
        sweeps: this.deps.tools.sweeps,
        book: turn.book,
        topicTitle: turn.topicTitle,
        mainAuthor: turn.mainAuthor,
      },
      input,
      engine: await this.batchEngine(turn, budget.sweep ?? SWEEP),
      ...(llm.contextTokens && { contextTokens: llm.contextTokens }),
      budget,
      startedAt: turn.startedAt,
      requestsBefore: turn.calls,
      ...(this.deps.clock && { clock: this.deps.clock }),
      ...(this.deps.pacer && { pacer: this.deps.pacer }),
      answer: (messages) => this.sweepAnswer(turn, messages),
    });
  }

  /** The turn's model as the sweep calls it: no tools, a batch's output, the spend guarded. */
  private async batchEngine(
    turn: Turn,
    budget: SweepBudget,
  ): Promise<BatchEngine> {
    const { llm } = turn.engine;
    const price = await llm.price();
    turn.finalReserveUsd = await this.answerReserve(turn);
    const output = llm.maxOutputTokens(budget.outputTokens);
    return {
      free: llm.billing === 'free' || (price.input === 0 && price.output === 0),
      parallel: budget.parallel,
      extract: (request) =>
        this.extractBatch(turn, {
          ...request,
          outputTokens: budget.outputTokens,
        }),
      // Every batch at its whole output budget, and the answer: an upper bound.
      estimateUsd: async (chars, calls) =>
        tokensForChars(chars) * price.input +
        calls * output * price.output +
        turn.finalReserveUsd,
    };
  }

  /**
   * What the answer call may cost: its rules, the conversation so far and findings as long
   * as one batch, at its whole output budget. The batches never spend it (code review).
   */
  private answerReserve(turn: Turn): Promise<number> {
    const { llm, spend } = turn.engine;
    const { input } = turn;
    const rules = promptText(
      sweepAnswerMessages(turn, {
        ...input,
        findings: [],
        partial: true,
        cut: 0,
      }),
    );
    return spend.estimate(
      rules + ' '.repeat(batchCharsFor(llm.contextTokens)),
      llm.maxOutputTokens(turn.budget.outputTokens),
    );
  }

  private async extractBatch(
    turn: Turn,
    request: {
      system: string;
      user: string;
      signal: AbortSignal;
      outputTokens: number;
    },
  ): Promise<string> {
    const messages: AgentMessage[] = [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ];
    const prompt = promptText(messages);
    const { outputTokens: maxTokens, signal } = request;
    const reserved = await this.reserveSpend(turn, prompt, maxTokens);
    const call: CallResult = { text: '', toolCalls: [], usage: null };
    turn.calls += 1;
    try {
      const options = { maxTokens, signal, toolChoice: 'none' as const };
      await collectCall(
        turn.engine.llm.streamAgent(messages, [], options),
        call,
      );
    } finally {
      await this.accountReserved(turn, call, { prompt, reserved });
    }
    return call.text;
  }

  /** The exhaustive answer from the merged findings, without the model's coverage line. */
  private async *sweepAnswer(
    turn: Turn,
    messages: AgentMessage[],
  ): AsyncIterable<ResearchEvent> {
    turn.messages.splice(0, turn.messages.length, ...messages);
    const filter = new CoverageLineFilter();
    turn.filter = filter;
    await this.guard(turn, true);
    yield* this.callModel(turn, true);
    yield* turn.answer.text(filter.end());
    yield* turn.answer.ended();
    yield* this.ensureAnswer(turn);
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
    const prompt = researchSystemPrompt(
      { title: turn.topicTitle, mainAuthor: turn.mainAuthor },
      'deep',
    );
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
    await spend.guard(
      turn.usd + turn.reservedUsd + turn.finalReserveUsd + estimate,
    );
    turn.reservedUsd += estimate;
    return estimate;
  }

  private async *callModel(
    turn: Turn,
    final: boolean,
  ): AsyncGenerator<ResearchEvent, CallResult> {
    const call: CallResult = { text: '', toolCalls: [], usage: null };
    const prompt = promptText(turn.messages);
    turn.calls += 1;
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
    // The sweep's answer comes from the findings only: no tools (ADR 0021).
    const tools = turn.filter ? [] : this.definitions(turn);
    const chunks = turn.engine.llm.streamAgent(turn.messages, tools, {
      maxTokens: turn.budget.outputTokens,
      signal: turn.input.signal,
      toolChoice: final ? 'none' : 'auto',
    });
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
      // The exhaustive answer never shows the model's own coverage line (ADR 0021).
      const shown = turn.filter ? turn.filter.push(chunk.text) : chunk.text;
      // Text after a tool call in the same call is the model's, not the reader's.
      if (call.toolCalls.length === 0) yield* turn.answer.text(shown);
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
    const prepared = runnable.map((c) => this.prepare(turn, c));
    for (const { steps } of prepared)
      for (const step of steps) yield { type: 'step', step };
    const outputs = await Promise.all(prepared.map((p) => p.run()));
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

  /** The tools of this turn: the exhaustive orchestrator also plans the sweep (ADR 0021). */
  private definitions(turn: Turn) {
    return turn.budget.sweep
      ? [...this.deps.tools.definitions, PLAN_SWEEP_DEFINITION]
      : this.deps.tools.definitions;
  }

  private prepare(turn: Turn, call: ToolCall): PreparedCall {
    if (call.name !== PLAN_SWEEP_TOOL || !turn.budget.sweep)
      return this.deps.tools.prepare(call, {
        topic: turn.input.topic,
        book: turn.book,
      });
    const plan = parsedArgs(sweepPlanSchema, parseJson(call.arguments));
    if (typeof plan === 'string') return failed(plan);
    return {
      steps: [{ kind: 'sweep', text: 'Planejando a varredura completa' }],
      run: async () => {
        turn.plan = plan;
        return 'Plano registrado: o aplicativo varre o conjunto inteiro agora.';
      },
    };
  }

  /** A sweep batch's cost: its reservation is freed only once the real cost is in. */
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
      steps: turn.steps,
      ...(turn.escalated ? { escalated: true } : {}),
      ...(turn.sweep && { coverage: turn.sweep.coverage }),
      ...(turn.sweep?.cursor && { sweep: turn.sweep.cursor }),
    };
  }
}
