import { setTimeout as sleep } from 'node:timers/promises';
import {
  BATCH_PROMPT_START,
  CONDENSE_PROMPT_START,
  PLAN_SWEEP_TOOL,
} from '../modules/research/index.js';
import type {
  AgentChunk,
  AgentLlmPort,
  AgentMessage,
  AgentStreamOptions,
  LlmChunk,
  LlmMessage,
  LlmPrice,
  LlmStreamOptions,
  ToolDefinition,
} from '../ports/llm.js';

/** One scripted model reply: tool calls (arguments as objects) or the final text. */
export type StubReply =
  | {
      readonly toolCalls: readonly {
        readonly name: string;
        readonly arguments: Record<string, unknown>;
      }[];
      /** Written before the tool calls: the agent thinking aloud, then retracted (ADR 0009). */
      readonly thought?: string;
    }
  | { readonly text: string };

/** The default script's thought before it reads (E2E shows it as "Pensando: …"). */
export const STUB_THOUGHT =
  'Um dos documentos parece tratar disso; confiro o trecho. ';

export interface StubLlmOptions {
  readonly answer?: string;
  readonly balance?: number | null;
  readonly configured?: boolean;
  readonly tokenDelayMs?: number;
  /** Agent replies by call position in the turn; past the end (or toolChoice "none") it answers. */
  readonly script?: readonly StubReply[];
  /** Cost reported per agent call; default: US$ 1 per million tokens. */
  readonly usdPerCall?: number;
  /** How its turns are paid; default per token (a subscription in tests of that path). */
  readonly billing?: AgentLlmPort['billing'];
  /** The model name it reports; default "stub/model". */
  readonly model?: string;
  /** What the forced last call (toolChoice "none") writes; default: an answer citing [n]. */
  readonly finalText?: string;
  /** What a sweep batch call writes (KBC-030); default: one finding on its first document. */
  readonly batchReply?: (user: string) => string;
  /** Milliseconds each agent call waits before replying (parallelism tests). */
  readonly callDelayMs?: number;
}

/** A sweep's batch or condensing call (KBC-030): no tools, findings as lines. */
const isBatch = (messages: AgentHistory): boolean => {
  const system = messages[0]?.content ?? '';
  return (
    system.startsWith(BATCH_PROMPT_START) ||
    system.startsWith(CONDENSE_PROMPT_START)
  );
};

/**
 * A question with this marker makes each sweep batch take a moment (E2E only), so the
 * estimate and the progress can be seen (KBC-030).
 */
export const STUB_SLOW_SWEEP = '[varredura lenta]';
const SLOW_BATCH_MS = 700;

const batchDelay = (messages: AgentHistory): number =>
  isBatch(messages) && (messages[1]?.content ?? '').includes(STUB_SLOW_SWEEP)
    ? SLOW_BATCH_MS
    : 0;

/** The default exhaustive orchestrator (KBC-030): it plans the whole topic at once. */
function planReply(question: string): StubReply {
  return {
    toolCalls: [
      {
        name: PLAN_SWEEP_TOOL,
        arguments: { target: {}, extract: question.slice(0, 1000) || 'tudo' },
      },
    ],
  };
}

/** One finding on the batch's first document; condensing keeps the lines as they are. */
function defaultBatchReply(user: string): string {
  if (user.startsWith('Achados')) return user.split('\n').slice(1).join('\n');
  const title = /^\[D1\] ([^·\n]+)/m.exec(user)?.[1]?.trim();
  return title ? `- [D1] “${title}” trata do assunto — “trecho”` : 'NENHUM';
}

const DEFAULT_ANSWER = 'Segundo o acervo, a natureza é sétupla [1].';

/**
 * E2E hooks of the stub (KBC-029), in the question: "[lento]" makes each agent call wait
 * STUB_SLOW_CALL_MS (a turn long enough to reload or stop), "[falha]" makes the call fail.
 */
export const STUB_SLOW_MARKER = '[lento]';
export const STUB_FAIL_MARKER = '[falha]';
export const STUB_SLOW_CALL_MS = 1500;

async function honorMarkers(question: string, signal: AbortSignal) {
  if (question.includes(STUB_SLOW_MARKER))
    await pause(STUB_SLOW_CALL_MS, signal);
  if (question.includes(STUB_FAIL_MARKER))
    throw new Error('stub model failure');
}

const questionOf = (messages: AgentHistory): string =>
  messages[lastUserIndex(messages)]?.content ?? '';

/** Waits, or less when the turn is stopped meanwhile. */
const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  sleep(ms, undefined, { signal }).catch(() => undefined);
/** A query no document contains, so the default script has to search again (AC-1). */
export const STUB_NONSENSE_QUERY = 'xqzw kplvm';

type AgentHistory = readonly AgentMessage[];

const lastUserIndex = (messages: AgentHistory): number =>
  messages.findLastIndex((m) => m.role === 'user');

/** Model calls already made in this turn: the assistant tool-call messages after the question. */
const callsInTurn = (messages: AgentHistory): number =>
  messages
    .slice(lastUserIndex(messages) + 1)
    .filter((m) => m.role === 'assistant').length;

const lastToolOutput = (messages: AgentHistory): string =>
  messages.findLast((m) => m.role === 'tool')?.content ?? '';

/** The first "[n] Title" of the latest tool output (without its " · autoria: …" label). */
function firstReference(
  messages: AgentHistory,
): { n: number; title: string } | null {
  const match = /^\[(\d+)\] ([^\n—·]+)/m.exec(lastToolOutput(messages));
  return match?.[1] && match[2]
    ? { n: Number(match[1]), title: match[2].trim() }
    : null;
}

/**
 * The default research script (KB_CHAT_LLM=stub): a search that finds nothing, a search
 * with the question, a read of the first hit and an answer citing it.
 */
function defaultReply(messages: AgentHistory): StubReply {
  const call = callsInTurn(messages);
  const question = messages[lastUserIndex(messages)]?.content ?? '';
  if (call === 0) return search(STUB_NONSENSE_QUERY, 'exact');
  if (call === 1) return search(question, 'all');
  const first = firstReference(messages);
  if (call === 2 && first)
    return {
      thought: STUB_THOUGHT,
      toolCalls: [
        {
          name: 'read_document',
          arguments: { document: first.n, around: question },
        },
      ],
    };
  return { text: finalText(messages) };
}

const search = (query: string, mode: string): StubReply => ({
  toolCalls: [{ name: 'search_collection', arguments: { query, mode } }],
});

/** "- [n] “Título” trata do assunto" as the sweep's merged findings list it (KBC-030). */
const FOUND = /^- \[(\d+)\] “([^”]+)” trata do assunto/m;

function finalText(messages: AgentHistory): string {
  const found = FOUND.exec(messages[lastUserIndex(messages)]?.content ?? '');
  if (found)
    return `Segundo o acervo, “${found[2]}” trata do assunto [${found[1]}].`;
  const read = firstReference(messages);
  return read
    ? `Segundo o acervo, “${read.title}” trata do assunto [${read.n}].`
    : 'Procurei no acervo e não encontrei documentos sobre isso.';
}

/**
 * Deterministic model for tests and E2E (KB_CHAT_LLM=stub): a fixed answer for `stream`
 * and a scripted research turn for `streamAgent`, at US$ 1 per million tokens.
 */
export class StubLlmAdapter implements AgentLlmPort {
  readonly model: string;
  readonly billing: AgentLlmPort['billing'];
  /** Messages of the last call, calls made and tokens handed out, for assertions. */
  lastMessages: readonly AgentMessage[] = [];
  /** Options of every agent call, for assertions (toolChoice, maxTokens). */
  readonly agentCalls: AgentStreamOptions[] = [];
  /** Sweep batch calls made, and the most calls that ran at once (KBC-030). */
  batchCalls = 0;
  maxActive = 0;
  /** When each agent call started (ms, before any delay): a stop must come before none. */
  readonly callStarts: number[] = [];
  /** The tool names the orchestrator (not a sweep batch) saw on its last call. */
  lastTools: string[] = [];
  /** The tool names of every orchestrator call, in order. */
  readonly toolsSeen: string[][] = [];
  /** The messages of every orchestrator call, in order. */
  readonly messagesSeen: (readonly AgentMessage[])[] = [];
  private active = 0;
  calls = 0;
  yielded = 0;

  constructor(private readonly options: StubLlmOptions = {}) {
    this.model = options.model ?? 'stub/model';
    this.billing = options.billing ?? 'per-token';
  }

  configured(): boolean {
    return this.options.configured ?? true;
  }

  maxOutputTokens(requested: number): number {
    return requested;
  }

  async price(): Promise<LlmPrice> {
    return { input: 1e-6, output: 1e-6 };
  }

  async balance(): Promise<number | null> {
    return this.options.balance === undefined ? 10 : this.options.balance;
  }

  async *stream(
    messages: readonly LlmMessage[],
    options: LlmStreamOptions,
  ): AsyncIterable<LlmChunk> {
    this.lastMessages = [...messages];
    this.calls += 1;
    yield* this.words(this.options.answer ?? DEFAULT_ANSWER, messages, options);
  }

  async *streamAgent(
    messages: readonly AgentMessage[],
    tools: readonly ToolDefinition[],
    options: AgentStreamOptions,
  ): AsyncIterable<AgentChunk> {
    this.callStarts.push(performance.now());
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      yield* this.agentReply(messages, tools, options);
    } finally {
      this.active -= 1;
    }
  }

  private async *agentReply(
    messages: readonly AgentMessage[],
    tools: readonly ToolDefinition[],
    options: AgentStreamOptions,
  ): AsyncIterable<AgentChunk> {
    const delay = this.options.callDelayMs ?? batchDelay(messages);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    await honorMarkers(questionOf(messages), options.signal);
    const reply = this.replyTo(messages, tools, options);
    if ('text' in reply) {
      yield* this.words(reply.text, messages, options);
      return;
    }
    if (reply.thought) yield* this.words(reply.thought, messages, options);
    for (const [index, call] of reply.toolCalls.entries())
      yield {
        type: 'tool_call',
        call: {
          id: `stub_${this.calls}_${index}`,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      };
    yield {
      type: 'usage',
      usage: this.usage(messages, reply.toolCalls.length),
    };
  }

  /** Records the call and picks the reply: a sweep batch's, or the orchestrator's. */
  private replyTo(
    messages: readonly AgentMessage[],
    tools: readonly ToolDefinition[],
    options: AgentStreamOptions,
  ): StubReply {
    this.calls += 1;
    this.agentCalls.push(options);
    if (isBatch(messages)) {
      this.batchCalls += 1;
      const user = messages[1]?.content ?? '';
      return { text: (this.options.batchReply ?? defaultBatchReply)(user) };
    }
    this.lastMessages = [...messages];
    this.lastTools = tools.map((tool) => tool.name);
    this.toolsSeen.push(this.lastTools);
    this.messagesSeen.push(this.lastMessages);
    const canPlan = tools.some((tool) => tool.name === PLAN_SWEEP_TOOL);
    return this.reply(messages, { ...options, canPlan });
  }

  private reply(
    messages: AgentHistory,
    options: AgentStreamOptions & { readonly canPlan: boolean },
  ): StubReply {
    if (options.toolChoice === 'none')
      return { text: this.options.finalText ?? finalText(messages) };
    if (!this.options.script && options.canPlan)
      return planReply(messages[lastUserIndex(messages)]?.content ?? '');
    if (!this.options.script) return defaultReply(messages);
    return (
      this.options.script[callsInTurn(messages)] ?? {
        text: finalText(messages),
      }
    );
  }

  private async *words(
    text: string,
    messages: AgentHistory,
    options: LlmStreamOptions,
  ): AsyncIterable<LlmChunk> {
    const words = text.split(/(?<= )/);
    for (const word of words) {
      if (options.signal.aborted) return;
      if (this.options.tokenDelayMs)
        await new Promise((resolve) =>
          setTimeout(resolve, this.options.tokenDelayMs),
        );
      this.yielded += 1;
      yield { type: 'token', text: word };
    }
    yield { type: 'usage', usage: this.usage(messages, words.length) };
  }

  private usage(messages: AgentHistory, outputTokens: number) {
    const inputTokens = Math.ceil(
      messages.reduce((sum, m) => sum + m.content.length, 0) / 4,
    );
    return {
      inputTokens,
      outputTokens,
      usd: this.options.usdPerCall ?? (inputTokens + outputTokens) * 1e-6,
    };
  }
}
