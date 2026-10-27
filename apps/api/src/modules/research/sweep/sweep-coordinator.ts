import type {
  SweepCoverage,
  SweepCursor,
  SweepProgress,
  SweepStopReason,
  SweepTotals,
} from '@kb-chat/contracts';
import { AppError } from '../../../app-error.js';
import { LlmKeyRejectedError } from '../../../ports/llm-errors.js';
import type { SourceBook } from '../source-book.js';
import { FindingSet, parseFindings, parseNumbered } from './findings.js';
import {
  batchSystemPrompt,
  batchUserPrompt,
  condenseSystemPrompt,
} from './sweep-prompts.js';
import type { SweepBatch, SweepLayout, SweepPlanner } from './sweep-planner.js';
import { Slots } from './slots.js';

/**
 * The OpenRouter free tier allows 20 requests a minute: one start every 3.2 s stays under
 * it (KBC-030). On a refused request (429, every model of the chain busy) the sweep waits
 * and tries again, then stops with a cursor.
 */
export const SWEEP_PACE = {
  freeGapMs: 3_200,
  backoffMs: [15_000, 30_000, 60_000],
} as const;

/** Errors that end the sweep (not the turn) and what the coverage says about them. */
const STOPPING_CODES: Readonly<Record<string, SweepStopReason>> = {
  DAILY_CAP_REACHED: 'spend',
  LLM_INSUFFICIENT_CREDIT: 'spend',
  HOUSE_QUOTA_EXHAUSTED: 'requests',
};

/** A batch failure that ends the turn with this code (a CLI logged out or missing). */
export class SweepFatalError extends Error {
  constructor(readonly code: string) {
    super(`sweep failed: ${code}`);
    this.name = 'SweepFatalError';
  }
}

/** One model call of a sweep without tools, on whatever runs the turn (ADR 0021). */
export interface BatchEngine {
  /** Free models: paced and announced as slower and less rigorous. */
  readonly free: boolean;
  /** Batches at once. */
  readonly parallel: number;
  /** The call's text. Errors: AppError (cap), LlmCapacityError (rate limits), others. */
  extract(call: {
    readonly system: string;
    readonly user: string;
    readonly signal: AbortSignal;
  }): Promise<string>;
}

export interface SweepClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

const realClock: SweepClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    }),
};

export interface SweepDeps {
  readonly engine: BatchEngine;
  readonly sweeps: Pick<SweepPlanner, 'batchText'>;
  readonly emit: (progress: SweepProgress) => void;
  readonly clock?: SweepClock;
}

export interface SweepRequest {
  readonly topic: string;
  readonly topicTitle: string;
  readonly question: string;
  readonly layout: SweepLayout;
  /** The totals of the turns this one continues. */
  readonly previous?: SweepTotals;
  readonly book: SourceBook;
  readonly signal: AbortSignal;
  /** No batch starts after this time (ms since the epoch); null: none. */
  readonly deadline: number | null;
  /** Model requests the sweep may make (the final answer's is kept apart). */
  readonly maxRequests: number;
  /** Requests the turn already made (planning), for the estimate. */
  readonly requestsBefore: number;
  /** Findings past this many characters are condensed before the answer. */
  readonly findingsChars: number;
}

export interface SweepOutcome {
  readonly findings: FindingSet;
  readonly coverage: SweepCoverage;
  /** Where to continue; null when the whole set was covered. */
  readonly cursor: SweepCursor | null;
  /** Model requests the sweep made. */
  readonly requests: number;
  /** Findings that did not fit even after condensing. */
  readonly cut: number;
}

/** Thrown inside a batch to end the whole turn (a refused key). */
class TurnFailure extends Error {
  constructor(override readonly cause: unknown) {
    super('sweep failed');
  }
}

/**
 * Runs an exhaustive sweep's batches (KBC-030, ADR 0021): every batch is one model call,
 * a few at a time, paced on free models, retried after refusals; it stops early only at a
 * ceiling (time, requests, spend, capacity) or the reader's stop. The coverage and cursor
 * come from what really finished, never from what the model says.
 */
export class SweepCoordinator {
  private readonly clock: SweepClock;
  private request!: SweepRequest;
  private findings!: FindingSet;
  private done: boolean[] = [];
  private requests = 0;
  private nextStart = 0;
  private stopped: SweepStopReason | null = null;
  private failure: TurnFailure | null = null;

  constructor(private readonly deps: SweepDeps) {
    this.clock = deps.clock ?? realClock;
  }

  async run(request: SweepRequest): Promise<SweepOutcome> {
    this.request = request;
    this.findings = new FindingSet(request.book);
    const { batches } = request.layout;
    this.done = batches.map(() => false);
    this.deps.emit(this.progress('planned'));
    const slots = new Slots(this.deps.engine.parallel);
    await Promise.all(batches.map((b) => slots.run(() => this.batch(b))));
    if (this.failure) throw this.failure.cause;
    const cut = await this.condense();
    return {
      ...this.measure(),
      findings: this.findings,
      requests: this.requests,
      cut,
    };
  }

  private async batch(batch: SweepBatch): Promise<void> {
    if (!(await this.mayStart())) return;
    const { text, labels } = await this.deps.sweeps.batchText(
      this.request.topic,
      batch,
    );
    const output = await this.call(
      batchSystemPrompt(this.request.topicTitle),
      batchUserPrompt({
        ...this.request,
        extract: this.request.layout.plan.extract,
        text,
      }),
    );
    if (output === null) return;
    this.findings.addFound(parseFindings(output, labels));
    this.done[batch.index] = true;
    this.deps.emit(this.progress('running'));
  }

  /** Checks the ceilings, then waits for the free pace; false when the sweep must stop. */
  private async mayStart(): Promise<boolean> {
    if (!this.canGoOn()) return false;
    if (this.deps.engine.free) {
      const now = this.clock.now();
      const at = Math.max(now, this.nextStart);
      this.nextStart = at + SWEEP_PACE.freeGapMs;
      if (at > now) await this.clock.sleep(at - now, this.request.signal);
    }
    return this.takeRequest();
  }

  /** Counts a request before it starts, so batches in parallel never pass the budget. */
  private takeRequest(): boolean {
    if (!this.canGoOn()) return false;
    this.requests += 1;
    return true;
  }

  private canGoOn(): boolean {
    const { signal, deadline, maxRequests } = this.request;
    if (signal.aborted) this.stop('stopped');
    else if (deadline !== null && this.clock.now() >= deadline)
      this.stop('time');
    else if (this.requests >= maxRequests) this.stop('requests');
    return this.stopped === null && this.failure === null;
  }

  private stop(reason: SweepStopReason): void {
    this.stopped ??= reason;
  }

  /**
   * One model call (its request already counted) with the waits after refusals; null when
   * the sweep stopped.
   */
  private async call(system: string, user: string): Promise<string | null> {
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.attempt(system, user);
      if (result.ok) return result.text;
      if (!(await this.retryAfter(result.err, attempt))) return null;
    }
  }

  private async attempt(
    system: string,
    user: string,
  ): Promise<{ ok: true; text: string } | { ok: false; err: unknown }> {
    const { signal } = this.request;
    try {
      return {
        ok: true,
        text: await this.deps.engine.extract({ system, user, signal }),
      };
    } catch (err) {
      return { ok: false, err };
    }
  }

  /** Waits after a refusal and counts the next try; false when the sweep must stop. */
  private async retryAfter(err: unknown, attempt: number): Promise<boolean> {
    const wait = this.afterFailure(err, attempt);
    if (wait === null) return false;
    await this.clock.sleep(wait, this.request.signal);
    return this.takeRequest();
  }

  /** How long to wait before trying again, or null after stopping (or failing) the sweep. */
  private afterFailure(err: unknown, attempt: number): number | null {
    if (this.request.signal.aborted) this.stop('stopped');
    else if (err instanceof AppError && STOPPING_CODES[err.code])
      this.stop(STOPPING_CODES[err.code] ?? 'capacity');
    else if (
      err instanceof AppError ||
      err instanceof LlmKeyRejectedError ||
      err instanceof SweepFatalError
    )
      this.failure ??= new TurnFailure(err);
    else if (attempt < SWEEP_PACE.backoffMs.length)
      return SWEEP_PACE.backoffMs[attempt] ?? null;
    else this.stop('capacity');
    return null;
  }

  /** Findings too long for the answer call are merged by the model, a part at a time. */
  private async condense(): Promise<number> {
    const cap = this.request.findingsChars;
    for (let round = 0; round < 2 && this.size() > cap; round += 1) {
      const parts = chunks(this.findings.lines(), cap);
      const merged = new FindingSet(this.request.book);
      for (const part of parts) {
        const output = this.takeRequest()
          ? await this.call(
              condenseSystemPrompt(this.request.topicTitle),
              `Achados:\n${part.join('\n')}`,
            )
          : null;
        merged.addNumbered(
          output === null
            ? linesAsItems(part)
            : parseNumbered(output, this.request.book),
        );
      }
      this.findings = merged;
    }
    return this.trim(cap);
  }

  private size(): number {
    return this.findings.lines().join('\n').length;
  }

  /** What still does not fit is left out, and counted. */
  private trim(cap: number): number {
    const lines = this.findings.lines();
    const kept = chunks(lines, cap)[0] ?? [];
    if (kept.length === lines.length) return 0;
    const trimmed = new FindingSet(this.request.book);
    trimmed.addNumbered(linesAsItems(kept));
    this.findings = trimmed;
    return lines.length - kept.length;
  }

  /** The documents fully swept, in id order, from the cursor on. */
  private prefix(): number {
    const { docs, skipped, batches } = this.request.layout;
    const batchOf = new Map<string, number[]>();
    for (const batch of batches)
      for (const unit of batch.units)
        batchOf.set(unit.entry.id, [
          ...(batchOf.get(unit.entry.id) ?? []),
          batch.index,
        ]);
    let count = skipped;
    while (count < docs.length) {
      const id = docs[count]?.entry.id ?? '';
      if (!(batchOf.get(id) ?? []).every((i) => this.done[i])) break;
      count += 1;
    }
    return count;
  }

  private totals(): { totals: SweepTotals; swept: number; after?: string } {
    const { layout, previous } = this.request;
    const swept = this.prefix();
    const read = layout.docs
      .slice(0, swept)
      .filter((d) => d.units.length > 0).length;
    const totals: SweepTotals = {
      documents: layout.docs.length,
      scanned: layout.withHits === null ? swept : layout.scanned,
      withHits: layout.withHits,
      read,
      batches: (previous?.batches ?? 0) + this.done.filter(Boolean).length,
    };
    return { totals, swept, after: layout.docs[swept - 1]?.entry.id };
  }

  private measure(): Pick<SweepOutcome, 'coverage' | 'cursor'> {
    const { totals, swept, after } = this.totals();
    const missing = totals.documents - swept;
    const { plan } = this.request.layout;
    const reason = missing > 0 ? (this.stopped ?? 'stopped') : undefined;
    const coverage: SweepCoverage = {
      ...totals,
      target: plan.target,
      phrases: plan.phrases,
      missing,
      ...(reason ? { reason } : {}),
    };
    const cursor =
      missing > 0 ? { plan, ...(after ? { after } : {}), totals } : null;
    return { coverage, cursor };
  }

  private progress(status: SweepProgress['status']): SweepProgress {
    const { totals, swept, after } = this.totals();
    const { layout, requestsBefore } = this.request;
    const batches = layout.batches.length;
    return {
      status,
      documents: totals.documents,
      documentsDone: swept,
      batches,
      batchesDone: this.done.filter(Boolean).length,
      requests: requestsBefore + batches + 1,
      free: this.deps.engine.free,
      ...(status === 'running'
        ? { cursor: { plan: layout.plan, ...(after ? { after } : {}), totals } }
        : {}),
    };
  }
}

/** Lines in consecutive groups of at most `cap` characters (a longer line alone). */
function chunks(lines: readonly string[], cap: number): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (current.length > 0 && size + line.length + 1 > cap) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) out.push(current);
  return out;
}

const linesAsItems = (lines: readonly string[]) =>
  lines.flatMap((line) => {
    const match = /^- \[(\d+)\] (.*)$/.exec(line);
    return match?.[1] && match[2]
      ? [{ n: Number(match[1]), text: match[2] }]
      : [];
  });
