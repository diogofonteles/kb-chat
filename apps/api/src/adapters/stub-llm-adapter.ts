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
  /** The model name it reports; default "stub/model". */
  readonly model?: string;
  /** What the forced last call (toolChoice "none") writes; default: an answer citing [n]. */
  readonly finalText?: string;
  /** A sub-researcher's replies by call position in its own conversation (ADR 0014). */
  readonly subScript?: readonly StubReply[];
  /** Milliseconds each agent call waits before replying (parallelism tests). */
  readonly callDelayMs?: number;
}

/** How a sub-researcher's system prompt starts (prompt.ts, subAgentSystemPrompt). */
const SUB_AGENT_PROMPT = 'Você é um sub-pesquisador';

const isSubAgent = (messages: AgentHistory): boolean =>
  messages[0]?.content.startsWith(SUB_AGENT_PROMPT) ?? false;

/** The default orchestrator's first move when it may delegate: two tasks on the question. */
function delegateReply(question: string): StubReply {
  return {
    toolCalls: [
      {
        name: 'delegate',
        arguments: {
          tasks: [
            { title: 'Primeira parte', task: question },
            { title: 'Segunda parte', task: question },
          ],
        },
      },
    ],
  };
}

const DEFAULT_ANSWER = 'Segundo o acervo, a natureza é sétupla [1].';
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

/** "“Título” trata do assunto [n]" as a sub-researcher's report says it. */
const REPORTED = /“([^”]+)” trata do assunto \[(\d+)\]/;

function finalText(messages: AgentHistory): string {
  const reported = REPORTED.exec(lastToolOutput(messages));
  if (reported)
    return `Segundo o acervo, “${reported[1]}” trata do assunto [${reported[2]}].`;
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
  readonly billing = 'per-token' as const;
  /** Messages of the last call, calls made and tokens handed out, for assertions. */
  lastMessages: readonly AgentMessage[] = [];
  /** Options of every agent call, for assertions (toolChoice, maxTokens). */
  readonly agentCalls: AgentStreamOptions[] = [];
  /** Sub-researcher calls made, and the most that ran at once (ADR 0014). */
  subCalls = 0;
  maxActive = 0;
  /** When each agent call started (ms, before any delay): a stop must come before none. */
  readonly callStarts: number[] = [];
  /** The tool names the orchestrator (not a sub-researcher) saw on its last call. */
  lastTools: string[] = [];
  private active = 0;
  calls = 0;
  yielded = 0;

  constructor(private readonly options: StubLlmOptions = {}) {
    this.model = options.model ?? 'stub/model';
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
    if (this.options.callDelayMs)
      await new Promise((resolve) =>
        setTimeout(resolve, this.options.callDelayMs),
      );
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

  /** Records the call and picks the reply: a sub-researcher's, or the orchestrator's. */
  private replyTo(
    messages: readonly AgentMessage[],
    tools: readonly ToolDefinition[],
    options: AgentStreamOptions,
  ): StubReply {
    const sub = isSubAgent(messages);
    if (sub) this.subCalls += 1;
    else {
      this.lastMessages = [...messages];
      this.lastTools = tools.map((tool) => tool.name);
    }
    this.calls += 1;
    this.agentCalls.push(options);
    const canDelegate = tools.some((tool) => tool.name === 'delegate');
    return sub
      ? this.subReply(messages, options)
      : this.reply(messages, { ...options, canDelegate });
  }

  private subReply(
    messages: AgentHistory,
    options: AgentStreamOptions,
  ): StubReply {
    if (options.toolChoice === 'none') return { text: finalText(messages) };
    const scripted = this.options.subScript;
    if (!scripted) return defaultReply(messages);
    return scripted[callsInTurn(messages)] ?? { text: finalText(messages) };
  }

  private reply(
    messages: AgentHistory,
    options: AgentStreamOptions & { readonly canDelegate: boolean },
  ): StubReply {
    if (options.toolChoice === 'none')
      return { text: this.options.finalText ?? finalText(messages) };
    if (!this.options.script && options.canDelegate)
      return callsInTurn(messages) === 0
        ? delegateReply(messages[lastUserIndex(messages)]?.content ?? '')
        : { text: finalText(messages) };
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
