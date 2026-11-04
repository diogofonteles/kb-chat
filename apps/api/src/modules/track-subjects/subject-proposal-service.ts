import { randomUUID } from 'node:crypto';
import {
  MAX_TRACK_SUBJECTS,
  subjectKey,
  type EditSubjects,
  type MediaItem,
  type ProposalEstimate,
  type ProposalFailure,
  type SpendCap,
  type SubjectRun,
  type TrackSubjects,
} from '@kb-chat/contracts';
import { startOfAppMonth } from '../../app-calendar.js';
import { AppError } from '../../app-error.js';
import type { LlmMessage, LlmPort, LlmPrice } from '../../ports/llm.js';
import type { MediaSpendLedgerPort } from '../../ports/media-spend-ledger.js';
import type {
  TrackSubjectStorePort,
  TrackSuggestions,
} from '../../ports/track-subject-store.js';
import type { TranscriptStorePort } from '../../ports/transcript-store.js';
import type { MediaActor } from '../media/index.js';
import { tokensOf } from '../spend/index.js';
import { subjectMessages, subjectOutputTokens } from './subject-prompt.js';
import {
  acceptSubjects,
  acceptSummary,
  parseSubjectReply,
  type KnownSubjects,
  type TrackReply,
} from './subject-reply.js';
import type { TrackSubjectService } from './track-subject-service.js';

/** A stalled provider must not hold a run forever (as KBC-067). */
const CALL_TIMEOUT_MS = 120_000;

interface TrackSpan {
  readonly mediaId: string;
  readonly title: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface SubjectProposalDeps {
  readonly store: TrackSubjectStorePort;
  readonly ledger: MediaSpendLedgerPort;
  readonly subjects: Pick<TrackSubjectService, 'collection' | 'tracksOf'>;
  readonly items: { tracksOf(parentId: string): readonly TrackSpan[] };
  readonly edits: {
    edit(
      mediaId: string,
    ): { readonly version: number; readonly status: string } | null;
  };
  readonly transcripts: Pick<TranscriptStorePort, 'transcripts' | 'segments'>;
  /** The recording as this person sees it; throws MEDIA_NOT_FOUND when they cannot. */
  readonly findMedia: (actor: MediaActor, mediaId: string) => MediaItem;
  /** The collection's title for the prompt. */
  readonly titleOf?: (topic: string) => string;
  /** The app's AI for media (ADR 0016); null when not connected. */
  readonly llm: () => LlmPort | null;
  readonly caps: { readonly runUsd: number; readonly monthlyUsd: number };
  readonly now?: () => Date;
  readonly onRunError?: (error: unknown, runId: string) => void;
}

interface Plan {
  readonly item: MediaItem;
  /** The tracks in the prompt's order: "faixa 3" of the reply is the third of these. */
  readonly trackIds: readonly string[];
  readonly editVersion: number;
  readonly messages: readonly LlmMessage[];
  readonly maxTokens: number;
  readonly estimateUsd: number;
  readonly price: LlmPrice;
  readonly llm: LlmPort;
}

/** What the one call gave. */
interface CallResult {
  readonly answer: string | null;
  readonly spentUsd: number;
  readonly error?: unknown;
}

const capError = (cap: SpendCap) =>
  new AppError('MEDIA_SPEND_CAP', `The media ${cap} would be crossed`, {
    details: { cap },
  });

const conflict = (reason: string) =>
  new AppError('MEDIA_CONFLICT', 'No subjects can be suggested now', {
    details: { reason },
  });

/** Words of the transcript that fall inside a track, by segment. */
function speechOf(
  segments: ReadonlyArray<{ startMs: number; endMs: number; text: string }>,
  track: TrackSpan,
): string {
  return segments
    .filter(
      (segment) =>
        segment.endMs > track.startMs && segment.startMs < track.endMs,
    )
    .map((segment) => segment.text.trim())
    .join(' ');
}

function knownOf(collection: {
  readonly concepts: readonly string[];
  readonly free: readonly { id: string; name: string }[];
}): KnownSubjects {
  return {
    concepts: new Map(
      collection.concepts.map((name) => [subjectKey(name), name]),
    ),
    free: new Map(collection.free.map((one) => [subjectKey(one.name), one.id])),
  };
}

/**
 * "Sugerir assuntos com IA" (KBC-069 FR-3, ADR 0029 §7): the estimate first, then one call
 * over all the tracks, reserved against the media ledger with the caps of KBC-067 (BR-5). It
 * never asks twice by itself, and what it leaves is chips waiting for a person (BR-3).
 */
export class SubjectProposalService {
  private readonly now: () => Date;
  private readonly running = new Set<Promise<void>>();
  private readonly closing = new AbortController();

  constructor(private readonly deps: SubjectProposalDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Step 4 of an approved recording: its tracks, the newest run, what can still run. */
  edit(actor: MediaActor, mediaId: string): EditSubjects {
    const item = this.deps.findMedia(actor, mediaId);
    const tracks = this.deps.subjects.tracksOf(item);
    return {
      tracks,
      run: this.deps.store.latestRun(mediaId),
      canSuggest: this.canSuggest(mediaId, tracks.length),
    };
  }

  /** Whether this approval can still get its suggestions. */
  private canSuggest(mediaId: string, tracks: number): boolean {
    const edit = this.deps.edits.edit(mediaId);
    if (tracks === 0 || edit?.status !== 'approved') return false;
    return (
      !this.deps.store.hasDoneRun(mediaId, edit.version) &&
      this.deps.store.latestRun(mediaId)?.status !== 'running'
    );
  }

  async estimate(
    actor: MediaActor,
    mediaId: string,
  ): Promise<ProposalEstimate> {
    const plan = await this.prepare(actor, mediaId);
    const used = this.deps.ledger.usedSince(startOfAppMonth(this.now()));
    const refusal = this.refusalOf(plan.estimateUsd, used);
    return {
      estimateUsd: plan.estimateUsd,
      runCapUsd: this.deps.caps.runUsd,
      windows: 1,
      model: plan.llm.model,
      allowed: refusal === null,
      refusal,
      month: actor.isMaster
        ? { spentUsd: used, capUsd: this.deps.caps.monthlyUsd }
        : null,
    };
  }

  /** Reserves the estimate and starts the run; it goes on after the answer. */
  async start(actor: MediaActor, mediaId: string): Promise<SubjectRun> {
    const plan = await this.prepare(actor, mediaId);
    const spendId = this.reserve(actor, plan);
    const run = this.startRun({ actor, plan, spendId });
    if (!run) {
      this.closeSpend(spendId, { failure: 'interrupted', spentUsd: 0 });
      throw conflict('subjects-running');
    }
    const work = this.execute({ run, spendId, plan })
      .catch((error: unknown) => this.deps.onRunError?.(error, run.id))
      .finally(() => this.running.delete(work));
    this.running.add(work);
    return run;
  }

  private startRun(input: {
    readonly actor: MediaActor;
    readonly plan: Plan;
    readonly spendId: string;
  }): SubjectRun | null {
    const { plan, spendId, actor } = input;
    try {
      return this.deps.store.startRun({
        id: randomUUID(),
        mediaId: plan.item.id,
        editVersion: plan.editVersion,
        principal: actor.principal,
        model: plan.llm.model,
        spendId,
        estimateUsd: plan.estimateUsd,
        now: this.now(),
      });
    } catch (err) {
      this.closeSpend(spendId, { failure: 'interrupted', spentUsd: 0 });
      throw err;
    }
  }

  /** At start: a run a stopped API left going ends as failed. */
  recover(): number {
    return this.deps.store.interruptRunning(this.now());
  }

  /** Stops the runs in flight and waits until each is written down. */
  async stop(): Promise<void> {
    this.closing.abort();
    await this.idle();
  }

  async idle(): Promise<void> {
    await Promise.all([...this.running]);
  }

  private async execute(input: {
    readonly run: SubjectRun;
    readonly spendId: string;
    readonly plan: Plan;
  }): Promise<void> {
    const { run, spendId, plan } = input;
    const result = await this.call(plan);
    if (result.error !== undefined)
      this.deps.onRunError?.(result.error, run.id);
    const reply =
      result.answer === null ? null : parseSubjectReply(result.answer);
    const failure = this.failureOf(result, reply);
    try {
      this.deps.store.finishRun({
        runId: run.id,
        spendId,
        failure,
        spentUsd: result.spentUsd,
        suggestions: reply ? this.suggestionsOf(plan, reply) : [],
        now: this.now(),
      });
    } finally {
      // A no-op when finishRun closed it; the safety net when it failed.
      this.closeSpend(spendId, { failure, spentUsd: result.spentUsd });
    }
  }

  private failureOf(
    result: CallResult,
    reply: readonly TrackReply[] | null,
  ): ProposalFailure | null {
    if (result.answer === null)
      return this.closing.signal.aborted ? 'interrupted' : 'provider';
    return reply === null ? 'invalid-output' : null;
  }

  /** Read at the end: what a person did meanwhile counts against the room left. */
  private suggestionsOf(
    plan: Plan,
    reply: readonly TrackReply[],
  ): TrackSuggestions[] {
    const { item, trackIds } = plan;
    const known = knownOf(this.deps.subjects.collection(item.topic));
    const tracks = new Map(
      this.deps.subjects.tracksOf(item).map((one) => [one.mediaId, one]),
    );
    return reply.flatMap((one) => {
      const track = tracks.get(trackIds[one.faixa - 1] ?? '');
      return track ? [this.suggestionOf(track, one, known)] : [];
    });
  }

  private suggestionOf(
    track: TrackSubjects,
    reply: TrackReply,
    known: KnownSubjects,
  ): TrackSuggestions {
    const room = MAX_TRACK_SUBJECTS - track.subjects.length;
    return {
      mediaId: track.mediaId,
      subjects: acceptSubjects(reply, { known, room }),
      summary: acceptSummary(reply.resumo),
    };
  }

  /** The one call of a run; a stream that broke after it began may still be billed. */
  private async call(plan: Plan): Promise<CallResult> {
    const read = { answer: '', started: false, usd: null as number | null };
    try {
      const stream = plan.llm.stream(plan.messages, {
        maxTokens: plan.maxTokens,
        signal: AbortSignal.any([
          this.closing.signal,
          AbortSignal.timeout(CALL_TIMEOUT_MS),
        ]),
      });
      for await (const chunk of stream) {
        read.started = true;
        if (chunk.type === 'token') read.answer += chunk.text;
        else read.usd = this.costOf(plan, read.answer, chunk.usage);
      }
      return {
        answer: read.answer,
        spentUsd: read.usd ?? this.costOf(plan, read.answer, null),
      };
    } catch (error) {
      const spentUsd = read.started
        ? (read.usd ?? this.costOf(plan, read.answer, null))
        : 0;
      return { answer: null, spentUsd, error };
    }
  }

  private costOf(
    plan: Plan,
    answer: string,
    usage: {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly usd: number | null;
    } | null,
  ): number {
    if (usage?.usd != null) return usage.usd;
    const prompt = plan.messages.map((one) => one.content).join('\n');
    const input = usage?.inputTokens ?? tokensOf(prompt);
    const output = usage?.outputTokens ?? tokensOf(answer);
    return input * plan.price.input + output * plan.price.output;
  }

  private closeSpend(
    spendId: string,
    outcome: {
      readonly failure: ProposalFailure | null;
      readonly spentUsd: number;
    },
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

  /** The estimate reserved in the media ledger, or the cap it would cross (BR-5). */
  private reserve(actor: MediaActor, plan: Plan): string {
    const since = startOfAppMonth(this.now());
    const refusal = this.refusalOf(
      plan.estimateUsd,
      this.deps.ledger.usedSince(since),
    );
    if (refusal) throw capError(refusal);
    const id = randomUUID();
    const reserved = this.deps.ledger.reserve({
      id,
      kind: 'subject-proposal',
      mediaId: plan.item.id,
      principal: actor.principal,
      usd: plan.estimateUsd,
      capUsd: this.deps.caps.monthlyUsd,
      since,
      now: this.now(),
    });
    if (!reserved) throw capError('monthly-cap');
    return id;
  }

  /** What both estimate and run need; refuses what no run could do now. */
  private async prepare(actor: MediaActor, mediaId: string): Promise<Plan> {
    const item = this.deps.findMedia(actor, mediaId);
    const edit = this.deps.edits.edit(mediaId);
    if (edit?.status !== 'approved') throw conflict('not-approved');
    if (this.deps.store.hasDoneRun(mediaId, edit.version))
      throw conflict('subjects-suggested');
    if (this.deps.store.latestRun(mediaId)?.status === 'running')
      throw conflict('subjects-running');
    const tracks = this.deps.items.tracksOf(mediaId);
    if (tracks.length === 0) throw conflict('no-tracks');
    const llm = this.configuredLlm();
    const price = await this.priceOf(llm);
    const messages = this.messagesFor(item, tracks);
    const maxTokens = subjectOutputTokens(tracks.length);
    const prompt = messages.map((one) => one.content).join('\n');
    const usd = tokensOf(prompt) * price.input + maxTokens * price.output;
    return {
      item,
      trackIds: tracks.map((track) => track.mediaId),
      editVersion: edit.version,
      messages,
      maxTokens,
      price,
      llm,
      estimateUsd: Math.ceil(usd * 1e6) / 1e6,
    };
  }

  private messagesFor(
    item: MediaItem,
    tracks: readonly TrackSpan[],
  ): LlmMessage[] {
    const transcript = this.deps.transcripts.transcripts(item.id)[0];
    if (!transcript)
      throw new AppError('MEDIA_NOT_READY', 'This media has no transcript yet');
    const segments = this.deps.transcripts.segments(transcript.id);
    const { concepts, free } = this.deps.subjects.collection(item.topic);
    return subjectMessages({
      collection: this.deps.titleOf?.(item.topic) ?? item.topic,
      recording: item.title,
      subjects: [...concepts, ...free.map((one) => one.name)],
      tracks: tracks.map((track) => ({
        title: track.title,
        text: speechOf(segments, track),
      })),
    });
  }

  private configuredLlm(): LlmPort {
    const llm = this.deps.llm();
    if (!llm?.configured())
      throw new AppError('LLM_NOT_CONFIGURED', 'The app AI is not connected');
    return llm;
  }

  private async priceOf(llm: LlmPort): Promise<LlmPrice> {
    try {
      return await llm.price();
    } catch (err) {
      throw new AppError('PROVIDER_UNAVAILABLE', 'The model price is unknown', {
        cause: err,
      });
    }
  }
}
