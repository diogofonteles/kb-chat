import { randomUUID } from 'node:crypto';
import type {
  DraftTracks,
  MediaItem,
  ProposalEstimate,
  ProposalRun,
  SpendCap,
} from '@kb-chat/contracts';
import { startOfAppMonth } from '../../app-calendar.js';
import { AppError } from '../../app-error.js';
import type { LlmPort } from '../../ports/llm.js';
import type { MediaSpendLedgerPort } from '../../ports/media-spend-ledger.js';
import type {
  ResumableRun,
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
  /** The failed run this one goes on from, when there is one. */
  readonly resumes: ResumableRun | null;
}

const capError = (cap: SpendCap) =>
  new AppError('MEDIA_SPEND_CAP', `The media ${cap} would be crossed`, {
    details: { cap },
  });

/**
 * The AI's track proposals (KBC-067): an estimate first, then a run reserved against the
 * media monthly budget that writes draft tracks window by window. Nothing is applied: the
 * draft waits for a person (BR-1, KBC-066). What a failed run finished stays and is not paid
 * twice: the next run asks only the windows missing (KBC-072 BR-6). It takes a person asking,
 * here or by "Tentar de novo"; nothing resumes by itself, a restart included.
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
    const { plan } = await this.prepare(actor, mediaId);
    const used = this.deps.ledger.usedSince(startOfAppMonth(this.now()));
    const refusal = this.refusalOf(plan.estimateUsd, used);
    return {
      estimateUsd: plan.estimateUsd,
      runCapUsd: this.deps.caps.runUsd,
      windows: plan.windows.length - plan.fromWindow,
      model: plan.model,
      allowed: refusal === null,
      refusal,
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
    return { estimateUsd, refusal: this.refusalOf(estimateUsd, used) };
  }

  /** Reserves the estimate and starts the run; it goes on after the answer (FR-1). */
  async start(actor: MediaActor, mediaId: string): Promise<ProposalRun> {
    const prepared = await this.prepare(actor, mediaId);
    if (this.deps.store.isApproved(mediaId))
      throw new AppError('MEDIA_CONFLICT', 'Reopen this edit first', {
        details: { reason: 'approved' },
      });
    const spendId = this.reserve(actor, prepared.plan);
    const run = this.startRun({ actor, prepared, spendId });
    if (!run) {
      this.closeSpend(spendId, { failure: 'interrupted', spentUsd: 0 });
      throw new AppError('MEDIA_CONFLICT', 'A proposal is already running');
    }
    this.track(run.id, this.execute({ runId: run.id, spendId, prepared }));
    return run;
  }

  /** The run's row; a failure to write it gives the reservation back before throwing. */
  private startRun(input: {
    readonly actor: MediaActor;
    readonly prepared: Prepared;
    readonly spendId: string;
  }): ProposalRun | null {
    const { plan, resumes } = input.prepared;
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
        carriedUsd: prepared.resumes?.spentUsd ?? 0,
        signal: this.closing.signal,
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

  private refusalOf(estimateUsd: number, usedUsd: number): SpendCap | null {
    if (estimateUsd > this.deps.caps.runUsd) return 'run-cap';
    if (usedUsd + estimateUsd > this.deps.caps.monthlyUsd) return 'monthly-cap';
    return null;
  }

  /** The estimate reserved in the media ledger, or the cap it would cross (BR-3). */
  private reserve(actor: MediaActor, plan: ProposalPlan): string {
    const since = startOfAppMonth(this.now());
    const refusal = this.refusalOf(
      plan.estimateUsd,
      this.deps.ledger.usedSince(since),
    );
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
    const resumes = this.deps.store.resumable(mediaId, transcript.id);
    return resumes?.windowsTotal === plan.windows.length
      ? { plan: planFrom(plan, resumes.windowsDone), llm, resumes }
      : { plan, llm, resumes: null };
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
