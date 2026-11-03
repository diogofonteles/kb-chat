import {
  MAX_CARRIED_FINDINGS,
  MAX_FOUND_PER_PROGRESS,
  type SweepCoverage,
  type SweepCursor,
  type SweepFinding,
  type SweepProgress,
  type SweepStopReason,
  type SweepTotals,
} from '@kb-chat/contracts';
import { AppError } from '../../../app-error.js';
import { LlmKeyRejectedError } from '../../../ports/llm-errors.js';
import type { SourceBook } from '../source-book.js';
import {
  FindingSet,
  carriedOf,
  parseFindings,
  parseNumbered,
  type FoundItem,
} from './findings.js';
import {
  coverageOf,
  cursorOf,
  measureSweep,
  type SweepMeasure,
} from './sweep-measure.js';
import {
  FREE_PACER,
  SWEEP_PACE,
  realClock,
  type SweepPacer,
  type SweepClock,
} from './sweep-pacing.js';
import {
  batchSystemPrompt,
  batchUserPrompt,
  condenseSystemPrompt,
} from './sweep-prompts.js';
import type { SweepBatch, SweepLayout, SweepPlanner } from './sweep-planner.js';
import { Slots } from './slots.js';

export { SWEEP_PACE, type SweepClock } from './sweep-pacing.js';

/** Errors that end the sweep (not the turn) and what the coverage says about them. */
export const STOPPING_CODES: Readonly<Record<string, SweepStopReason>> = {
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
  /** At most what `calls` calls over `chars` characters cost, in US$; absent: unknown. */
  estimateUsd?(chars: number, calls: number): Promise<number>;
}

export interface SweepDeps {
  readonly engine: BatchEngine;
  readonly sweeps: Pick<SweepPlanner, 'batchText'>;
  readonly emit: (progress: SweepProgress) => void;
  /** Default: the real clock. */
  readonly clock?: SweepClock;
  /** Paces free-model requests; default the process's (FREE_PACER). */
  readonly pacer?: SweepPacer;
}

export interface SweepRequest {
  readonly topic: string;
  readonly topicTitle: string;
  /** The collection's main author (KBC-049), or null. */
  readonly mainAuthor: string | null;
  readonly question: string;
  readonly layout: SweepLayout;
  /** The totals of the turns this one continues. */
  readonly previous?: SweepTotals;
  /** What those turns found: merged into this turn's findings (QA F-1). */
  readonly carried?: readonly SweepFinding[];
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
  /** The cursor even when nothing is left (an answer that could not be written). */
  readonly resume: SweepCursor;
  /** Model requests the sweep made. */
  readonly requests: number;
  /** Findings that did not fit even after condensing. */
  readonly cut: number;
}

/** Thrown inside a batch to end the whole turn (a refused key, a vault error). */
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
  constructor(private readonly deps: SweepDeps) {}

  run(request: SweepRequest): Promise<SweepOutcome> {
    return new SweepRun(this.deps, request).run();
  }
}

/** The state of one sweep: one instance per run. */
class SweepRun {
  private readonly clock: SweepClock;
  private readonly pacer: SweepPacer;
  private findings: FindingSet;
  private readonly done: boolean[];
  private requests = 0;
  private stopped: SweepStopReason | null = null;
  private failure: TurnFailure | null = null;

  constructor(
    private readonly deps: SweepDeps,
    private readonly request: SweepRequest,
  ) {
    this.clock = deps.clock ?? realClock;
    this.pacer = deps.pacer ?? FREE_PACER;
    this.findings = new FindingSet(request.book);
    this.findings.addFound(carriedItems(request));
    this.done = request.layout.batches.map(() => false);
  }

  async run(): Promise<SweepOutcome> {
    this.deps.emit(await this.planned());
    const slots = new Slots(this.deps.engine.parallel);
    const { batches } = this.request.layout;
    await Promise.all(batches.map((b) => slots.run(() => this.guarded(b))));
    this.rethrow();
    const cut = await this.condense();
    // A failure in a condensing call (a refused key) fails the turn too.
    this.rethrow();
    return this.outcome(cut);
  }

  private rethrow(): void {
    if (this.failure) throw this.failure.cause;
  }

  /** A batch whose failure (a vault error) stops the others instead of leaving them running. */
  private async guarded(batch: SweepBatch): Promise<void> {
    try {
      await this.batch(batch);
    } catch (err) {
      this.failure ??= new TurnFailure(err);
    }
  }

  private async batch(batch: SweepBatch): Promise<void> {
    if (!(await this.mayStart())) return;
    const { request } = this;
    const { text, labels } = await this.deps.sweeps.batchText(
      request.topic,
      batch,
    );
    const extract = request.layout.plan.extract;
    const output = await this.call(
      batchSystemPrompt(request.topicTitle, request.mainAuthor),
      batchUserPrompt({ ...request, extract, text }),
    );
    // A call cut short by "Parar" may return part of its text: it never counts.
    if (output === null || request.signal.aborted) return;
    const found = parseFindings(output, labels);
    this.findings.addFound(found);
    this.done[batch.index] = true;
    this.deps.emit(this.progress(found));
  }

  /** Checks the ceilings, then waits for the free pace; false when the sweep must stop. */
  private async mayStart(): Promise<boolean> {
    if (!this.canGoOn()) return false;
    await this.pace();
    return this.takeRequest();
  }

  private async pace(): Promise<void> {
    if (this.deps.engine.free)
      await this.pacer.wait(this.clock, this.request.signal);
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
      const text = await this.deps.engine.extract({ system, user, signal });
      return { ok: true, text };
    } catch (err) {
      return { ok: false, err };
    }
  }

  /** Waits after a refusal, keeps the free pace and counts the next try; false: stop. */
  private async retryAfter(err: unknown, attempt: number): Promise<boolean> {
    const wait = this.afterFailure(err, attempt);
    if (wait === null) return false;
    await this.clock.sleep(wait, this.request.signal);
    if (!this.canGoOn()) return false;
    await this.pace();
    return this.takeRequest();
  }

  /** How long to wait before trying again, or null after stopping (or failing) the sweep. */
  private afterFailure(err: unknown, attempt: number): number | null {
    const stopping = err instanceof AppError ? STOPPING_CODES[err.code] : null;
    if (this.request.signal.aborted) this.stop('stopped');
    else if (stopping) this.stop(stopping);
    else if (isFatal(err)) this.failure ??= new TurnFailure(err);
    else if (attempt < SWEEP_PACE.backoffMs.length)
      return SWEEP_PACE.backoffMs[attempt] ?? null;
    else this.stop('capacity');
    return null;
  }

  /** Findings too long for the answer call are merged by the model, a part at a time. */
  private async condense(): Promise<number> {
    const cap = this.request.findingsChars;
    for (let round = 0; round < 2 && this.size() > cap; round += 1) {
      const merged = new FindingSet(this.request.book);
      for (const part of chunks(this.findings.lines(), cap))
        merged.addNumbered(await this.condensed(part));
      this.findings = merged;
    }
    return this.trim(cap);
  }

  private async condensed(part: readonly string[]) {
    // Paced like a batch: a condensing call is a request to the same account.
    const output = (await this.mayStart())
      ? await this.call(
          condenseSystemPrompt(this.request.topicTitle),
          `Achados:\n${part.join('\n')}`,
        )
      : null;
    return output === null
      ? linesAsItems(part)
      : parseNumbered(output, this.request.book);
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

  private measure(): SweepMeasure {
    return measureSweep(this.request.layout, {
      done: this.done,
      previousBatches: this.request.previous?.batches ?? 0,
    });
  }

  private outcome(cut: number): SweepOutcome {
    const { layout } = this.request;
    const ending = {
      measure: this.measure(),
      stopped: this.stopped,
      findings: this.findings.carried(MAX_CARRIED_FINDINGS),
      continued: this.request.previous !== undefined,
    };
    const resume = cursorOf(layout, ending);
    return {
      findings: this.findings,
      coverage: coverageOf(layout, ending),
      cursor: ending.measure.missing > 0 ? resume : null,
      resume,
      requests: this.requests,
      cut,
    };
  }

  /** Before the first batch: what the sweep will take (time on free models, US$ on paid). */
  private async planned(): Promise<SweepProgress> {
    const { batches } = this.request.layout;
    const base = this.progressBase('planned');
    const { engine } = this.deps;
    const chars = batches.reduce((sum, b) => sum + b.chars, 0);
    const usd = engine.free
      ? undefined
      : await engine.estimateUsd?.(chars, batches.length);
    const minutes = engine.free
      ? Math.ceil((base.requests * SWEEP_PACE.freeGapMs) / 60_000)
      : undefined;
    return {
      ...base,
      ...(minutes !== undefined && { minutes }),
      ...(usd !== undefined && { usd }),
    };
  }

  private progress(found: readonly FoundItem[]): SweepProgress {
    const measure = this.measure();
    return {
      ...this.progressBase('running', measure),
      cursor: cursorOf(this.request.layout, { measure, findings: [] }),
      found: found
        .slice(0, MAX_FOUND_PER_PROGRESS)
        .map(({ entry, text }) => carriedOf(entry, text)),
    };
  }

  private progressBase(
    status: SweepProgress['status'],
    measure = this.measure(),
  ): SweepProgress {
    const { layout, requestsBefore } = this.request;
    const batches = layout.batches.length;
    return {
      status,
      documents: measure.totals.documents,
      needed: measure.needed,
      documentsDone: measure.totals.read,
      batches,
      batchesDone: this.done.filter(Boolean).length,
      requests: requestsBefore + batches + 1,
      free: this.deps.engine.free,
    };
  }
}

const isFatal = (err: unknown): boolean =>
  err instanceof AppError ||
  err instanceof LlmKeyRejectedError ||
  err instanceof SweepFatalError;

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

/** The carried findings of documents in this set; any other id is dropped (never trusted). */
function carriedItems({ layout, carried = [] }: SweepRequest): FoundItem[] {
  const byId = new Map(layout.docs.map((doc) => [doc.entry.id, doc.entry]));
  return carried.flatMap(({ id, text }) => {
    const entry = byId.get(id);
    return entry ? [{ entry, text }] : [];
  });
}
