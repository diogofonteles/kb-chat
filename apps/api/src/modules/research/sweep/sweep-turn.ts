import type {
  ResearchEvent,
  ResearchTurn,
  SweepCoverage,
  SweepCursor,
  SweepPlan,
} from '@kb-chat/contracts';
import type { AgentMessage } from '../../../ports/llm.js';
import { EventPipe } from '../event-pipe.js';
import type { SourceBook } from '../source-book.js';
import {
  SweepCoordinator,
  type BatchEngine,
  type SweepClock,
  type SweepOutcome,
} from './sweep-coordinator.js';
import type { SweepLayout, SweepPlanner } from './sweep-planner.js';
import { sweepAnswerMessages } from './sweep-prompts.js';

/** Characters a batch may take per token of the model's context (half of it, ~3.2 chars/token). */
const CHARS_PER_CONTEXT_TOKEN = 1.6;
const MIN_BATCH_CHARS = 24_000;
const MAX_BATCH_CHARS = 300_000;
/** A model whose context is unknown (free routers, one's own model): a small one. */
export const DEFAULT_CONTEXT_TOKENS = 32_000;
/** The subscription CLIs' models (Claude Code, Codex) have large contexts. */
export const SUBSCRIPTION_CONTEXT_TOKENS = 160_000;

/** The batch size for a model's context: half of it goes to document text (ADR 0021). */
export const batchCharsFor = (contextTokens = DEFAULT_CONTEXT_TOKENS): number =>
  Math.min(
    MAX_BATCH_CHARS,
    Math.max(
      MIN_BATCH_CHARS,
      Math.round(contextTokens * CHARS_PER_CONTEXT_TOKEN),
    ),
  );

/** What a runner lends the sweep of one exhaustive turn. */
export interface SweepTurnHost {
  readonly sweeps: SweepPlanner;
  readonly topic: string;
  readonly topicTitle: string;
  readonly question: string;
  readonly history: readonly ResearchTurn[];
  readonly book: SourceBook;
  readonly signal: AbortSignal;
  /** "Continuar varredura": the cursor of the turn this one continues. */
  readonly cursor?: SweepCursor;
  readonly engine: BatchEngine;
  readonly contextTokens?: number;
  readonly deadline: number | null;
  /** Model requests the whole turn may make (planning, batches and the answer). */
  readonly maxRequests: number;
  /** Requests the turn made while planning. */
  readonly requestsBefore: number;
  readonly clock?: SweepClock;
  /** Streams the final answer of these messages (the runner's model, no tools). */
  answer(messages: AgentMessage[]): AsyncIterable<ResearchEvent>;
}

/** What the turn's `done` event carries about the sweep. */
export interface SweepTurnResult {
  readonly coverage: SweepCoverage;
  readonly cursor: SweepCursor | null;
  readonly batches: number;
}

/**
 * The exhaustive turn after planning (KBC-030, ADR 0021), the same for every runner: the
 * app resolves the plan's whole set, sweeps it in batches (estimate and progress streamed
 * as `sweep` events), merges the findings into the turn's numbering, and only then asks
 * for the final answer. A stopped turn gets no answer; its coverage and cursor still come.
 */
export async function* runSweepTurn(
  host: SweepTurnHost,
  plan: SweepPlan,
): AsyncGenerator<ResearchEvent, SweepTurnResult | null> {
  const batchChars = batchCharsFor(host.contextTokens);
  const layout = await host.sweeps.layout(host.topic, {
    plan,
    batchChars,
    ...(host.cursor?.after ? { after: host.cursor.after } : {}),
  });
  if (!layout) return null;
  const outcome = yield* sweepAll(host, { layout, batchChars });
  const sources = host.book.list();
  if (sources.length > 0) yield { type: 'sources', sources };
  const { coverage, cursor } = outcome;
  const result = { coverage, cursor, batches: layout.batches.length };
  if (host.signal.aborted) return result;
  yield* host.answer(
    sweepAnswerMessages(host.topicTitle, {
      question: host.question,
      history: host.history,
      findings: outcome.findings.lines(),
      partial: outcome.cursor !== null,
      cut: outcome.cut,
    }),
  );
  return result;
}

/** Runs every batch, streaming the estimate and the progress as `sweep` events. */
async function* sweepAll(
  host: SweepTurnHost,
  { layout, batchChars }: { layout: SweepLayout; batchChars: number },
): AsyncGenerator<ResearchEvent, SweepOutcome> {
  const pipe = new EventPipe<ResearchEvent>();
  const coordinator = new SweepCoordinator({
    engine: host.engine,
    sweeps: host.sweeps,
    clock: host.clock,
    emit: (sweep) => pipe.push({ type: 'sweep', sweep }),
  });
  const running = coordinator
    .run({
      ...host,
      layout,
      previous: host.cursor?.totals,
      carried: host.cursor?.findings,
      maxRequests: Math.max(0, host.maxRequests - host.requestsBefore - 1),
      findingsChars: batchChars,
    })
    .finally(() => pipe.end());
  // Awaited below, after the pipe drains; this only keeps Node from calling it unhandled.
  running.catch(() => undefined);
  yield* pipe;
  return running;
}
