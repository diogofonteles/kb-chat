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
import { AnswerStream } from './answer-stream.js';
import { MAX_OUTPUT_TOKENS, PROFILE_STEPS } from './limits.js';
import { SourceBook } from './source-book.js';
import type { ResearchTools } from './tools.js';

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
  readonly answer: AnswerStream;
  /** The profile's step budget (KBC-011). */
  readonly maxSteps: number;
  steps: number;
  calls: number;
  sourcesSent: number;
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
 * relations through the tools, up to the profile's step budget (ADR 0009), then answers.
 * Text streams at once and is retracted when its call asks for tools (AnswerStream). The
 * spend is guarded before every model call and recorded once per turn.
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
      answer: new AnswerStream(),
      maxSteps: PROFILE_STEPS[input.profile],
      steps: 0,
      calls: 0,
      sourcesSent: 0,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
    };
  }

  private async *loop(turn: Turn): AsyncIterable<ResearchEvent> {
    for (;;) {
      if (turn.input.signal.aborted) return;
      const final = turn.steps >= turn.maxSteps;
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
      this.deps.llm.maxOutputTokens(MAX_OUTPUT_TOKENS),
    );
    await this.deps.spend.guard(turn.usd + estimate);
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
    // The forced last call is the answer even if the provider ignored "none" (OpenRouter).
    if (final || call.toolCalls.length === 0) yield* turn.answer.ended();
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
    const context = { topic: turn.input.topic, book: turn.book };
    const runnable = call.toolCalls.slice(0, turn.maxSteps - turn.steps);
    const prepared = runnable.map((c) => this.deps.tools.prepare(c, context));
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
