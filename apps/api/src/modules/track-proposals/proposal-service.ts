import { randomUUID } from 'node:crypto';
import type {
  DraftTracks,
  MediaItem,
  ProposalEstimate,
  ProposalRun,
  SpendCap,
} from '@kb-chat/contracts';
import { estimateRoseDetailsSchema } from '@kb-chat/contracts';
import { z } from 'zod';
import { startOfAppMonth } from '../../app-calendar.js';
import { AppError } from '../../app-error.js';
import type { LlmPort } from '../../ports/llm.js';
import type { MediaSpendLedgerPort } from '../../ports/media-spend-ledger.js';
import type {
  FailedAttempt,
  TrackProposalStorePort,
} from '../../ports/track-proposal-store.js';
import type { TranscriptStorePort } from '../../ports/transcript-store.js';
import type { MediaActor } from '../media/index.js';
import { buildPlan, planFrom, type ProposalPlan } from './proposal-plan.js';
import { WindowRunner, type RunOutcome } from './window-runner.js';
import { toPromptSegments, type PromptSegment } from './windows.js';

/** The collection's names the prompt carries (KBC-049; KBC-065 adds named speakers). */
export interface CollectionContext {
  readonly collection: string;
  readonly knownNames: readonly string[];
}

export interface ProposalServiceDeps {
  readonly store: TrackProposalStorePort;
  readonly ledger: MediaSpendLedgerPort;
  readonly transcripts: Pick<
    TranscriptStorePort,
    'transcripts' | 'segments' | 'currentTerms'
  >;
  /** The item as this person sees it; throws MEDIA_NOT_FOUND when they cannot. */
  readonly findMedia: (actor: MediaActor, mediaId: string) => MediaItem;
  readonly contextOf: (topic: string) => CollectionContext;
  /**
   * The voice of each segment of a transcript (KBC-064), or null without a separation: the
   * proposal then has no asker, answerer or names.
   */
  readonly segmentVoices: (
    mediaId: string,
    transcriptId: string,
  ) => readonly (number | null)[] | null;
  /** The app's AI for media, chosen by a master (ADR 0016); null when not connected. */
  readonly llm: () => LlmPort | null;
  readonly caps: { readonly runUsd: number; readonly monthlyUsd: number };
  readonly now?: () => Date;
  readonly onRunError?: (error: unknown, runId: string) => void;
  /** A window's tracks are in the draft (KBC-090: a name given meanwhile follows). */
  readonly onWindowSaved?: (mediaId: string) => void;
}

/** An estimate before there are words to read. */
export interface DurationEstimate {
  readonly estimateUsd: number;
  readonly refusal: SpendCap | null;
}

/** One line of speech per this long: the size of a transcript's segments. */
const SEGMENT_MS = 30_000;
/** Spoken Portuguese, in characters per second (150 words a minute). */
const SPOKEN_CHARS_PER_SECOND = 15;

/** Speech of this length, for a length-only estimate. */
function spokenSegments(durationMs: number): PromptSegment[] {
  const count = Math.max(1, Math.ceil(durationMs / SEGMENT_MS));
  const text = 'x'.repeat((SEGMENT_MS / 1000) * SPOKEN_CHARS_PER_SECOND);
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    startMs: index * SEGMENT_MS,
    endMs: (index + 1) * SEGMENT_MS,
    text,
    voice: 1,
  }));
}

interface Prepared {
  readonly plan: ProposalPlan;
  readonly llm: LlmPort;
  /** The failed run this one goes on from, when its finished windows still fit the plan. */
  readonly resumes: FailedAttempt | null;
  /** What the analysis has spent so far: the cap holds over all its attempts. */
  readonly carriedUsd: number;
  /** The plan no longer fits a failed run: its finished windows are paid again. */
  readonly restarts: boolean;
}

/** Windows of it are done, others are missing and the plan still cuts the same windows. */
const canResume = (attempt: FailedAttempt, windows: number): boolean =>
  attempt.windowsDone > 0 &&
  attempt.windowsDone < attempt.windowsTotal &&
  attempt.windowsTotal === windows;

/** How a start was agreed: what was on screen when the person pressed. */
export interface StartTerms {
  /** The newest run they saw; by default, the newest at the press. */
  readonly seenRunId?: string | null;
  /** The value they were told; a run that would cost more does not start (KBC-097). */
  readonly acceptedUsd?: number | undefined;
}

const ANALYSIS_TAKEN = 'analysis-taken';
const takenDetails = z.object({ reason: z.literal(ANALYSIS_TAKEN) });

const analysisTaken = () =>
  new AppError('MEDIA_CONFLICT', 'A proposal already started', {
    details: { reason: ANALYSIS_TAKEN },
  });

/** Another start got there first: its analysis stands and nothing stopped. */
export const isAnalysisTaken = (error: unknown): boolean =>
  error instanceof AppError &&
  error.code === 'MEDIA_CONFLICT' &&
  takenDetails.safeParse(error.details).success;

/** What a run would cost now, when that is more than the person agreed to; else null. */
export function roseEstimateOf(error: unknown): number | null {
  if (!(error instanceof AppError) || error.code !== 'MEDIA_CONFLICT')
    return null;
  const details = estimateRoseDetailsSchema.safeParse(error.details);
  return details.success ? details.data.estimateUsd : null;
}

const capError = (cap: SpendCap) =>
  new AppError('MEDIA_SPEND_CAP', `The media ${cap} would be crossed`, {
    details: { cap },
  });

/**
 * The AI's track proposals (KBC-067): an estimate first, then a run reserved against the
 * media monthly budget that writes draft tracks window by window. Nothing is applied: the
 * draft waits for a person (BR-1, KBC-066). What a failed run finished stays and is not paid
 * twice: the next run asks only the windows missing, and the spend of every failed attempt
 * goes along, so the run cap holds over the whole analysis (KBC-072 BR-6). It takes a person
 * asking, here or by "Tentar de novo"; nothing resumes by itself, a restart included.
 */
export class ProposalService {
  private readonly now: () => Date;
  private readonly running = new Set<Promise<void>>();
  private readonly closing = new AbortController();

  constructor(private readonly deps: ProposalServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async estimate(
    actor: MediaActor,
    mediaId: string,
  ): Promise<ProposalEstimate> {
    const { plan, carriedUsd, restarts } = await this.prepare(actor, mediaId);
    const used = this.deps.ledger.usedSince(startOfAppMonth(this.now()));
    const refusal = this.refusalOf({
      estimateUsd: plan.estimateUsd,
      usedUsd: used,
      carriedUsd,
    });
    return {
      estimateUsd: plan.estimateUsd,
      runCapUsd: this.deps.caps.runUsd,
      windows: plan.windows.length - plan.fromWindow,
      model: plan.model,
      allowed: refusal === null,
      refusal,
      restarts,
      month: actor.isMaster
        ? { spentUsd: used, capUsd: this.deps.caps.monthlyUsd }
        : null,
    };
  }

  /** The app's AI is connected (KBC-072 BR-3). */
  connected(): boolean {
    return this.deps.llm()?.configured() ?? false;
  }

  /** What the media's month has left (KBC-072 AC-3). */
  monthRemainingUsd(): number {
    const used = this.deps.ledger.usedSince(startOfAppMonth(this.now()));
    return Math.max(0, this.deps.caps.monthlyUsd - used);
  }

  /**
   * The estimate of a recording not transcribed yet, from its length alone (KBC-072 FR-7):
   * the same calculation as a run's, over speech at the measured pace.
   */
  async estimateByDuration(durationMs: number): Promise<DurationEstimate> {
    const llm = this.configuredLlm();
    const { estimateUsd } = buildPlan({
      mediaId: '',
      transcriptId: '',
      segments: spokenSegments(durationMs),
      context: {
        collection: '',
        knownNames: [],
        title: '',
        author: null,
        terms: this.deps.transcripts.currentTerms().terms,
      },
      model: { id: llm.model, price: await this.priceOf(llm) },
    });
    const used = this.deps.ledger.usedSince(startOfAppMonth(this.now()));
    const refusal = this.refusalOf({
      estimateUsd,
      usedUsd: used,
      carriedUsd: 0,
    });
    return { estimateUsd, refusal };
  }

  /** The newest run's id: what a person pressing now has in front of them. */
  newestRunId(mediaId: string): string | null {
    return this.deps.store.newestRun(mediaId)?.id ?? null;
  }

  /**
   * Reserves the estimate and starts the run; it goes on after the answer (FR-1). Single
   * flight: `seenRunId` is read before anything waits, and nothing waits from the check to
   * the run's row, so of the starts that saw the same run only the first pays. The API is one
   * process over this database (ADR 0010), so that stretch is atomic. What the person agreed
   * to is checked there too: a save after the estimate can change what a retry costs.
   */
  async start(
    actor: MediaActor,
    mediaId: string,
    terms: StartTerms = {},
  ): Promise<ProposalRun> {
    const { seenRunId = this.newestRunId(mediaId), acceptedUsd } = terms;
    const prepared = await this.prepare(actor, mediaId);
    this.assertNotTaken(mediaId, seenRunId);
    if (this.deps.store.isApproved(mediaId))
      throw new AppError('MEDIA_CONFLICT', 'Reopen this edit first', {
        details: { reason: 'approved' },
      });
    if (acceptedUsd !== undefined && prepared.plan.estimateUsd > acceptedUsd)
      throw new AppError('MEDIA_CONFLICT', 'The estimate rose', {
        details: {
          reason: 'estimate-rose',
          estimateUsd: prepared.plan.estimateUsd,
        },
      });
    const spendId = this.reserve(actor, prepared);
    const run = this.startRun({ actor, prepared, spendId });
    if (!run) {
      this.closeSpend(spendId, { failure: 'interrupted', spentUsd: 0 });
      throw analysisTaken();
    }
    this.track(run.id, this.execute({ runId: run.id, spendId, prepared }));
    return run;
  }

  private assertNotTaken(mediaId: string, seenRunId: string | null): void {
    const newest = this.deps.store.newestRun(mediaId);
    if (newest?.status === 'running' || (newest?.id ?? null) !== seenRunId)
      throw analysisTaken();
  }

  /** The run's row; a failure to write it gives the reservation back before throwing. */
  private startRun(input: {
    readonly actor: MediaActor;
    readonly prepared: Prepared;
    readonly spendId: string;
  }): ProposalRun | null {
    const { plan, resumes, carriedUsd } = input.prepared;
    try {
      return this.deps.store.startRun({
        id: randomUUID(),
        mediaId: plan.mediaId,
        transcriptId: plan.transcriptId,
        principal: input.actor.principal,
        model: plan.model,
        spendId: input.spendId,
        windowsTotal: plan.windows.length,
        estimateUsd: plan.estimateUsd,
        now: this.now(),
        carriedUsd,
        resumes,
      });
    } catch (err) {
      this.closeSpend(input.spendId, { failure: 'interrupted', spentUsd: 0 });
      throw err;
    }
  }

  getRun(actor: MediaActor, mediaId: string, runId: string): ProposalRun {
    this.deps.findMedia(actor, mediaId);
    const run = this.deps.store.getRun(runId);
    if (!run || run.mediaId !== mediaId)
      throw new AppError('NOT_FOUND', 'Unknown proposal run');
    return run;
  }

  draft(actor: MediaActor, mediaId: string): DraftTracks {
    this.deps.findMedia(actor, mediaId);
    return this.deps.store.draft(mediaId);
  }

  /**
   * At start: runs a stopped API left running end as failed, with their reservations, and
   * any reservation left open by a crash is refunded (it keeps what it recorded as spent).
   * Their finished windows stay; going on takes a person's click, with the value in sight.
   */
  recover(): number {
    const runs = this.deps.store.interruptRunning(this.now());
    const orphans = this.deps.ledger.refundOpen(this.now());
    return runs.length + orphans;
  }

  /** Stops the runs in flight (the API is closing) and waits until each is written down. */
  async stop(): Promise<void> {
    this.closing.abort();
    await this.idle();
  }

  /** Resolves when no run is in flight. */
  async idle(): Promise<void> {
    await Promise.all([...this.running]);
  }

  /** Keeps a run in flight until it ends; an error writing it down is reported, not thrown. */
  private track(runId: string, work: Promise<void>): void {
    const guarded = work
      .catch((error: unknown) => this.deps.onRunError?.(error, runId))
      .finally(() => this.running.delete(guarded));
    this.running.add(guarded);
  }

  /**
   * Runs the windows, then ends the run and its reservation together. The reservation is
   * closed in every case, with what the run really spent: a crash writing the run down
   * (the recording deleted meanwhile) still settles it (KBC-067 review).
   */
  private async execute(input: {
    readonly runId: string;
    readonly spendId: string;
    readonly prepared: Prepared;
  }): Promise<void> {
    const { runId, spendId, prepared } = input;
    let outcome: RunOutcome = { failure: 'provider', spentUsd: 0 };
    try {
      outcome = await new WindowRunner({
        runId,
        plan: prepared.plan,
        llm: prepared.llm,
        store: this.deps.store,
        runCapUsd: this.deps.caps.runUsd,
        carriedUsd: prepared.carriedUsd,
        signal: this.closing.signal,
        onWindowSaved: this.deps.onWindowSaved,
      }).run();
      if (outcome.error !== undefined)
        this.deps.onRunError?.(outcome.error, runId);
    } finally {
      this.finish({ runId, spendId, outcome });
    }
  }

  private finish(input: {
    readonly runId: string;
    readonly spendId: string;
    readonly outcome: RunOutcome;
  }): void {
    const { outcome } = input;
    try {
      this.deps.store.finishRun({
        runId: input.runId,
        spendId: input.spendId,
        failure: outcome.failure,
        spentUsd: outcome.spentUsd,
        now: this.now(),
      });
    } finally {
      // A no-op when finishRun closed it; the safety net when finishRun itself failed.
      this.closeSpend(input.spendId, outcome);
    }
  }

  /** A failed run gives back what it did not spend (FR-5); a done one counts what it spent. */
  private closeSpend(
    spendId: string,
    outcome: Pick<RunOutcome, 'failure' | 'spentUsd'>,
  ): void {
    this.deps.ledger.close({
      id: spendId,
      spentUsd: outcome.spentUsd,
      outcome: outcome.failure === null ? 'settled' : 'refunded',
      now: this.now(),
    });
  }

  /** The cap this would cross: the run's over all of the analysis' attempts (BR-3). */
  private refusalOf(cost: {
    readonly estimateUsd: number;
    readonly usedUsd: number;
    readonly carriedUsd: number;
  }): SpendCap | null {
    const { estimateUsd, usedUsd, carriedUsd } = cost;
    if (carriedUsd + estimateUsd > this.deps.caps.runUsd) return 'run-cap';
    if (usedUsd + estimateUsd > this.deps.caps.monthlyUsd) return 'monthly-cap';
    return null;
  }

  /** The estimate reserved in the media ledger, or the cap it would cross (BR-3). */
  private reserve(actor: MediaActor, prepared: Prepared): string {
    const { plan, carriedUsd } = prepared;
    const since = startOfAppMonth(this.now());
    const refusal = this.refusalOf({
      estimateUsd: plan.estimateUsd,
      usedUsd: this.deps.ledger.usedSince(since),
      carriedUsd,
    });
    if (refusal) throw capError(refusal);
    const id = randomUUID();
    const reserved = this.deps.ledger.reserve({
      id,
      kind: 'track-proposal',
      mediaId: plan.mediaId,
      principal: actor.principal,
      usd: plan.estimateUsd,
      capUsd: this.deps.caps.monthlyUsd,
      since,
      now: this.now(),
    });
    if (!reserved) throw capError('monthly-cap');
    return id;
  }

  /** The transcript, its voices and the model's price: what both estimate and run need. */
  private async prepare(actor: MediaActor, mediaId: string): Promise<Prepared> {
    const item = this.deps.findMedia(actor, mediaId);
    const transcript = this.deps.transcripts.transcripts(mediaId)[0];
    const segments = transcript
      ? this.deps.transcripts.segments(transcript.id)
      : [];
    if (!transcript || segments.length === 0)
      throw new AppError('MEDIA_NOT_READY', 'This media has no transcript yet');
    const llm = this.configuredLlm();
    const voices = this.deps.segmentVoices(mediaId, transcript.id);
    const plan = buildPlan({
      mediaId,
      transcriptId: transcript.id,
      segments: toPromptSegments(segments, voices),
      context: this.contextOf(item),
      model: { id: llm.model, price: await this.priceOf(llm) },
    });
    const attempt = this.deps.store.failedAttempt(mediaId, transcript.id);
    return { llm, ...this.goingOn(plan, attempt) };
  }

  /** The plan over what a failed run left: from where it stopped, or from the start. */
  private goingOn(
    plan: ProposalPlan,
    attempt: FailedAttempt | null,
  ): Omit<Prepared, 'llm'> {
    const carriedUsd = attempt?.spentUsd ?? 0;
    if (attempt && canResume(attempt, plan.windows.length))
      return {
        plan: planFrom(plan, attempt.windowsDone),
        resumes: attempt,
        carriedUsd,
        restarts: false,
      };
    const restarts = (attempt?.windowsDone ?? 0) > 0;
    return { plan, resumes: null, carriedUsd, restarts };
  }

  private contextOf(item: MediaItem) {
    const collection = this.deps.contextOf(item.topic);
    return {
      ...collection,
      title: item.title,
      author: item.author?.name ?? null,
      terms: this.deps.transcripts.currentTerms().terms,
    };
  }

  private configuredLlm(): LlmPort {
    const llm = this.deps.llm();
    if (!llm?.configured())
      throw new AppError('LLM_NOT_CONFIGURED', 'The app AI is not connected');
    return llm;
  }

  private async priceOf(llm: LlmPort) {
    try {
      return await llm.price();
    } catch (err) {
      throw new AppError('PROVIDER_UNAVAILABLE', 'The model price is unknown', {
        cause: err,
      });
    }
  }
}
