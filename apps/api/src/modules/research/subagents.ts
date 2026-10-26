import type { ResearchEvent, ResearchStep } from '@kb-chat/contracts';
import type {
  AgentChunk,
  AgentLlmPort,
  AgentMessage,
  LlmUsage,
  ToolCall,
} from '../../ports/llm.js';
import { tokensOf } from '../spend/index.js';
import { KEEP_TOOL_RESULTS, compactToolResults } from './compaction.js';
import type { DelegateArgs } from './delegate.js';
import type { DelegationBudget } from './limits.js';
import { SUB_AGENT_FINAL_NOTE, subAgentSystemPrompt } from './prompt.js';
import type { ResearchTools, ToolContext } from './tools.js';

/** A sub-researcher's model call: its text, the tools it asked for and what it cost. */
export interface SubCall {
  text: string;
  readonly toolCalls: ToolCall[];
  usage: LlmUsage | null;
}

/** What the orchestrating turn lends its sub-researchers (ADR 0014). */
export interface SubAgentHost {
  readonly llm: AgentLlmPort;
  readonly tools: ResearchTools;
  readonly context: ToolContext;
  readonly topicTitle: string;
  readonly budget: DelegationBudget;
  /** Estimated prompt tokens past which a sub-researcher compacts; null: never. */
  readonly compactTokens: number | null;
  readonly signal: AbortSignal;
  /**
   * The daily cap and credit, counting everything the turn spent and the calls still in
   * flight; returns the estimate it reserved for this call.
   */
  guard(prompt: string, outputTokens: number): Promise<number>;
  /** Adds a call's cost to the turn and frees its reservation. */
  account(
    call: SubCall,
    cost: { prompt: string; reserved: number },
  ): Promise<void>;
  /** Frees a reservation whose call never started (a stop after the guard). */
  release(reserved: number): void;
  /** When the turn must answer (its wall-clock ceiling), in ms since the epoch; null: none. */
  readonly deadline: number | null;
  /** Tool steps left in the turn's sub-researcher budget. */
  remainingSteps(): number;
  /** Reserves tool steps from that budget; returns how many it got. */
  reserveSteps(wanted: number): number;
  emit(event: ResearchEvent): void;
}

export interface SubTask {
  /** The sub-researcher's number in the turn ("Pesquisador N"). */
  readonly agent: number;
  readonly title: string;
  readonly task: string;
}

const SKIPPED =
  'Não executada: o limite de passos dos sub-pesquisadores foi atingido.';
const EMPTY_REPORT = 'O sub-pesquisador não escreveu relatório.';
const STOPPED_REPORT = 'Interrompido pelo leitor antes do relatório.';
const KEEP_WHEN_TIGHT = 2;

export const promptText = (messages: readonly AgentMessage[]): string =>
  messages
    .map((m) =>
      m.role === 'assistant'
        ? m.content + m.toolCalls.map((c) => c.arguments).join('')
        : m.content,
    )
    .join('\n');

function take(call: SubCall, chunk: AgentChunk): void {
  if (chunk.type === 'usage') call.usage = chunk.usage;
  else if (chunk.type === 'tool_call') call.toolCalls.push(chunk.call);
  else call.text += chunk.text;
}

/** One model call, collected (a sub-researcher never streams to the reader). */
async function callModel(
  host: SubAgentHost,
  messages: readonly AgentMessage[],
  { final, reserved }: { final: boolean; reserved: number },
): Promise<SubCall> {
  const call: SubCall = { text: '', toolCalls: [], usage: null };
  const prompt = promptText(messages);
  const definitions = host.tools.definitions;
  try {
    const chunks = host.llm.streamAgent(messages, definitions, {
      maxTokens: host.budget.outputTokens,
      signal: host.signal,
      toolChoice: final ? 'none' : 'auto',
    });
    for await (const chunk of chunks) take(call, chunk);
  } catch (err) {
    if (!host.signal.aborted) throw err;
  } finally {
    await host.account(call, { prompt, reserved });
  }
  return call;
}

/** Old tool results become a ledger once the sub-researcher's context grows (ADR 0013). */
function compact(host: SubAgentHost, messages: AgentMessage[]): void {
  const threshold = host.compactTokens;
  if (threshold === null) return;
  for (const keep of [KEEP_TOOL_RESULTS, KEEP_WHEN_TIGHT]) {
    if (tokensOf(promptText(messages)) <= threshold) return;
    const compacted = compactToolResults(messages, {
      book: host.context.book,
      keep,
    });
    messages.splice(0, messages.length, ...compacted.messages);
  }
}

/** Runs the tools a sub-researcher asked for, its steps streamed with its number. */
async function runTools(
  host: SubAgentHost,
  { agent, call, room }: { agent: number; call: SubCall; room: number },
): Promise<{ messages: AgentMessage[]; steps: number }> {
  const wanted = Math.min(call.toolCalls.length, room);
  const runnable = call.toolCalls.slice(0, host.reserveSteps(wanted));
  const prepared = runnable.map((c) => host.tools.prepare(c, host.context));
  for (const { steps } of prepared)
    for (const step of steps)
      host.emit({
        type: 'step',
        step: { ...step, agent } satisfies ResearchStep,
      });
  const outputs = await Promise.all(prepared.map((p) => p.run()));
  return {
    steps: runnable.length,
    messages: [
      { role: 'assistant', content: call.text, toolCalls: call.toolCalls },
      ...call.toolCalls.map((c, i) => ({
        role: 'tool' as const,
        toolCallId: c.id,
        content: outputs[i] ?? SKIPPED,
      })),
    ],
  };
}

/**
 * One sub-researcher (ADR 0014): a fresh context (its own prompt and the task), the
 * research tools without delegate, its own step budget, compaction, then a report for the
 * orchestrator. Returns the report and the tool steps it took.
 */
export async function runSubAgent(
  host: SubAgentHost,
  task: SubTask,
): Promise<{ report: string; steps: number }> {
  const messages: AgentMessage[] = [
    { role: 'system', content: subAgentSystemPrompt(host.topicTitle) },
    { role: 'user', content: task.task },
  ];
  let steps = 0;
  for (;;) {
    if (host.signal.aborted) return { report: STOPPED_REPORT, steps };
    const room = host.budget.steps - steps;
    const final = room <= 0 || mustReport(host);
    compact(host, messages);
    if (final) messages.push({ role: 'system', content: SUB_AGENT_FINAL_NOTE });
    const call = await guardedCall(host, messages, final);
    if (!call) return { report: STOPPED_REPORT, steps };
    if (final || call.toolCalls.length === 0)
      return { report: call.text.trim() || EMPTY_REPORT, steps };
    const ran = await runTools(host, { agent: task.agent, call, room });
    steps += ran.steps;
    messages.push(...ran.messages);
  }
}

/** The spend check, then the call; null when the reader stopped meanwhile (BR-5). */
async function guardedCall(
  host: SubAgentHost,
  messages: readonly AgentMessage[],
  final: boolean,
): Promise<SubCall | null> {
  const reserved = await host.guard(
    promptText(messages),
    host.budget.outputTokens,
  );
  if (host.signal.aborted) {
    host.release(reserved);
    return null;
  }
  return callModel(host, messages, { final, reserved });
}

/** The turn's tool-step budget is spent or its wall-clock ceiling passed: report now. */
const mustReport = (host: SubAgentHost): boolean =>
  host.remainingSteps() <= 0 ||
  (host.deadline !== null && Date.now() >= host.deadline);

/**
 * The turn's sub-researcher slots (ADR 0014): at most `size` run at once, across every
 * delegate call of the turn; the others wait in order.
 */
export class Slots {
  private free: number;
  private readonly waiting: (() => void)[] = [];

  constructor(size: number) {
    this.free = size;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free -= 1;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free += 1;
    }
  }
}

/**
 * Runs every item in the slots and waits for all of them, also after a failure (so each
 * call in flight is accounted); `onFailure` stops the others; the first error is rethrown.
 */
export async function runAll<T, R>(
  items: readonly T[],
  { slots, onFailure }: { slots: Slots; onFailure: () => void },
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const settled = await Promise.allSettled(
    items.map((item) =>
      slots
        .run(() => work(item))
        .catch((err: unknown) => {
          onFailure();
          throw err;
        }),
    ),
  );
  const failure = settled.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  return settled.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
}

/** The delegate call's steps: one per task, with the number of its sub-researcher. */
export const delegateSteps = (tasks: readonly SubTask[]): ResearchStep[] =>
  tasks.map(({ agent, title }) => ({ kind: 'delegate', text: title, agent }));

/** What the orchestrator reads back: one block per sub-researcher. */
export function reportsText(
  tasks: readonly SubTask[],
  reports: readonly string[],
): string {
  const blocks = tasks.map(
    ({ agent, title }, i) =>
      `### Pesquisador ${agent} — ${title}\n${reports[i] ?? EMPTY_REPORT}`,
  );
  return [
    `Relatórios de ${tasks.length} sub-pesquisador(es). As citações [n] deles valem na sua resposta; junte-os e tire as repetições.`,
    ...blocks,
  ].join('\n\n');
}

/** The numbered tasks of a delegate call, from the next free sub-researcher number. */
export const numberTasks = (
  args: DelegateArgs,
  firstAgent: number,
): SubTask[] =>
  args.tasks.map(({ title, task }, i) => ({
    agent: firstAgent + i,
    title,
    task,
  }));
