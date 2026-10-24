import type { ResearchEvent } from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import { LlmKeyRejectedError } from '../../ports/llm-errors.js';
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
  buildResearchMessages,
} from './prompt.js';
import { MAX_OUTPUT_TOKENS, MAX_TOOL_STEPS } from './limits.js';
import { PREAMBLE_HOLD_CHARS, preambleLength } from './answer-preamble.js';
import { SourceBook } from './source-book.js';
import type { ResearchTools } from './tools.js';

/**
 * Narration rule (ADR 0006): the reader never sees text from a model call that ends with
 * tool calls ("Vou ler os documentos…"). Each call's text is buffered; it is dropped when
 * the call asks for tools and shown when it does not. Waiting for the end of every call
 * would kill the streaming of the answer, so once the buffer passes this size with no tool
 * call yet, the call is taken as the answer: its text streams from then on and any tool call
 * it asks for afterwards is ignored. Narration in the real eval stayed under ~450
 * characters; answers run to thousands, so 800 leaves a margin at ~2-4 s of delay.
 */
export const NARRATION_HOLD_CHARS = 800;
const SKIPPED_CALL =
  'Não executada: o limite de passos desta resposta foi atingido.';

export interface ToolLoopRunnerDeps {
  readonly llm: AgentLlmPort;
  readonly tools: ResearchTools;
  readonly spend: SpendService;
}

interface Turn {
  readonly input: ResearchInput;
  readonly book: SourceBook;
  readonly messages: AgentMessage[];
  steps: number;
  calls: number;
  sourcesSent: number;
  shownText: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

interface CallResult {
  text: string;
  /** True once the call is taken as the answer: its text streams from then on. */
  started: boolean;
  /** Characters of `text` already streamed to the reader (or dropped as preamble). */
  shownLength: number;
  readonly toolCalls: ToolCall[];
  usage: LlmUsage | null;
}

/** True once the call's text started streaming: the call is the answer. */
const isAnswer = (call: CallResult): boolean => call.started;

/** A key the provider refused is the reader's to fix in Settings (KBC-007). */
function errorCode(err: unknown): string {
  if (err instanceof AppError) return err.code;
  return err instanceof LlmKeyRejectedError ? 'LLM_KEY_REJECTED' : 'INTERNAL';
}

type Done = Extract<ResearchEvent, { type: 'done' }>;

const promptText = (messages: readonly AgentMessage[]): string =>
  messages
    .map((m) =>
      m.role === 'assistant'
        ? m.content + m.toolCalls.map((c) => c.arguments).join('')
        : m.content,
    )
    .join('\n');

/**
 * The research agent's loop in the API (ADR 0006): the model searches, reads and follows
 * relations through the tools, up to MAX_TOOL_STEPS, then answers. The spend is guarded
 * before every model call and recorded once per turn.
 */
export class ToolLoopRunner implements ResearchRunnerPort {
  constructor(private readonly deps: ToolLoopRunnerDeps) {}

  get model(): string {
    return this.deps.llm.model;
  }

  get billing(): 'per-token' | 'subscription' {
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

  private startTurn(input: ResearchInput, topicTitle: string): Turn {
    return {
      input,
      book: new SourceBook(),
      messages: buildResearchMessages({ ...input, topicTitle }),
      steps: 0,
      calls: 0,
      sourcesSent: 0,
      shownText: '',
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
    };
  }

  private async *loop(turn: Turn): AsyncIterable<ResearchEvent> {
    for (;;) {
      if (turn.input.signal.aborted) return;
      const final = turn.steps >= MAX_TOOL_STEPS;
      if (final)
        turn.messages.push({ role: 'system', content: FINAL_ANSWER_NOTE });
      await this.guard(turn);
      const call = yield* this.callModel(turn, final);
      if (final || call.toolCalls.length === 0) {
        yield* this.ensureAnswer(turn);
        return;
      }
      yield* this.runTools(turn, call);
    }
  }

  /** Daily cap and credit before every model call, counting what this turn already spent. */
  private async guard(turn: Turn): Promise<void> {
    const estimate = await this.deps.spend.estimate(
      promptText(turn.messages),
      MAX_OUTPUT_TOKENS,
    );
    await this.deps.spend.guard(turn.usd + estimate);
  }

  private async *callModel(
    turn: Turn,
    final: boolean,
  ): AsyncGenerator<ResearchEvent, CallResult> {
    const call: CallResult = {
      text: '',
      started: false,
      shownLength: 0,
      toolCalls: [],
      usage: null,
    };
    const prompt = promptText(turn.messages);
    turn.calls += 1;
    try {
      yield* this.consume(turn, call, final);
    } catch (err) {
      if (!turn.input.signal.aborted) throw err;
    } finally {
      await this.account(turn, call, prompt);
    }
    if (call.toolCalls.length === 0) yield* this.flush(turn, call, true);
    return call;
  }

  private async *consume(
    turn: Turn,
    call: CallResult,
    final: boolean,
  ): AsyncIterable<ResearchEvent> {
    const chunks = this.deps.llm.streamAgent(
      turn.messages,
      this.deps.tools.definitions,
      {
        maxTokens: MAX_OUTPUT_TOKENS,
        signal: turn.input.signal,
        toolChoice: final ? 'none' : 'auto',
      },
    );
    for await (const chunk of chunks)
      yield* this.take(turn, call, { chunk, final });
  }

  private *take(
    turn: Turn,
    call: CallResult,
    { chunk, final }: { chunk: AgentChunk; final: boolean },
  ): Iterable<ResearchEvent> {
    if (chunk.type === 'usage') call.usage = chunk.usage;
    else if (chunk.type === 'tool_call') {
      if (!isAnswer(call)) call.toolCalls.push(chunk.call);
    } else {
      call.text += chunk.text;
      const holding =
        call.toolCalls.length > 0 || call.text.length < NARRATION_HOLD_CHARS;
      if (final || isAnswer(call) || !holding) yield* this.flush(turn, call);
    }
  }

  /**
   * Streams the call's text not shown yet; only one call per turn is ever shown (the one
   * taken as the answer). The answer's first characters are held until a preamble about the agent's own work can be
   * recognized and dropped ("Tenho tudo o que preciso. Vou compor a resposta.").
   */
  private *flush(
    turn: Turn,
    call: CallResult,
    ended = false,
  ): Iterable<ResearchEvent> {
    if (!call.started) {
      if (!ended && call.text.length < PREAMBLE_HOLD_CHARS) return;
      call.started = true;
      call.shownLength = preambleLength(call.text);
    }
    const fresh = call.text.slice(call.shownLength);
    if (!fresh) return;
    call.shownLength = call.text.length;
    turn.shownText += fresh;
    yield { type: 'token', text: fresh };
  }

  private async *ensureAnswer(turn: Turn): AsyncIterable<ResearchEvent> {
    if (turn.shownText.trim() || turn.input.signal.aborted) return;
    turn.shownText = EMPTY_ANSWER;
    yield { type: 'token', text: EMPTY_ANSWER };
  }

  private async *runTools(
    turn: Turn,
    call: CallResult,
  ): AsyncIterable<ResearchEvent> {
    const context = { topic: turn.input.topic, book: turn.book };
    const runnable = call.toolCalls.slice(0, MAX_TOOL_STEPS - turn.steps);
    const prepared = runnable.map((c) => this.deps.tools.prepare(c, context));
    for (const { step } of prepared) if (step) yield { type: 'step', step };
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
    turn.inputTokens += usage.inputTokens;
    turn.outputTokens += usage.outputTokens;
    turn.usd += await this.deps.spend.costOf(usage);
  }

  /** One ledger entry per turn with the summed usage (nothing spent, nothing recorded). */
  private async record(turn: Turn, interrupted: boolean): Promise<Done> {
    if (turn.calls > 0)
      await this.deps.spend.record({
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        usd: turn.usd,
        interrupted,
      });
    return {
      type: 'done',
      usd: turn.usd,
      billing: this.deps.llm.billing,
      model: this.deps.llm.model,
      interrupted,
      steps: turn.steps,
    };
  }
}
