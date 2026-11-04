import { randomUUID } from 'node:crypto';
import type {
  DiarizationStatus,
  DraftTrack,
  DraftTracks,
  MediaItem,
  MediaPreparation,
  OpenPreparations,
  OptionRefusal,
  PlanRefusals,
  PreparationOption,
  PreparationOptions,
  PreparationOptionsQuery,
  PreparationPlan,
  PreparationStage,
  PreparationStep,
  PreparationTrack,
  PreparationVoice,
  ProposalRun,
  RetryStage,
  StageStop,
  TrackPerson,
  TranscriptSpeakers,
  VoiceSuggestion,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { MediaEditStorePort } from '../../ports/media-edit-store.js';
import type {
  MeasuredRates,
  PreparationRecord,
  PreparationStorePort,
} from '../../ports/preparation-store.js';
import type {
  FailedAttempt,
  TrackProposalStorePort,
} from '../../ports/track-proposal-store.js';
import type {
  TranscriptStorePort,
  TranscriptSummary,
} from '../../ports/transcript-store.js';
import type { PlanActor, Presence } from '../media/index.js';
import type { DurationEstimate } from '../track-proposals/index.js';
import { isGuided, planRefusals, type PlanContext } from './plan-rules.js';
import {
  nextActionOf,
  stagesOf,
  stopOf,
  type PaidStageNow,
  type StageFacts,
} from './preparation-stages.js';

/** The AI's side of the plan: the proposals of KBC-067, whose rules stay theirs. */
export interface PlanProposals {
  connected(): boolean;
  monthRemainingUsd(): number;
  estimateByDuration(durationMs: number): Promise<DurationEstimate>;
  estimate(
    actor: PlanActor,
    mediaId: string,
  ): Promise<{ estimateUsd: number; refusal: StageStop | null }>;
  start(actor: PlanActor, mediaId: string): Promise<ProposalRun>;
}

export interface PreparationServiceDeps {
  readonly plans: PreparationStorePort;
  readonly transcripts: Pick<
    TranscriptStorePort,
    'transcripts' | 'requestTranscription'
  >;
  readonly separation: {
    status(mediaId: string): DiarizationStatus;
    voicesOn(
      mediaId: string,
      transcript: TranscriptSummary,
    ): { readonly speakers: TranscriptSpeakers } | null;
    /** Queues a separation; false when one is waiting or running. */
    request(mediaId: string): boolean;
  };
  readonly edits: Pick<MediaEditStorePort, 'edit'>;
  readonly drafts: Pick<TrackProposalStorePort, 'draft' | 'failedAttempt'>;
  /** The item as this person sees it; throws MEDIA_NOT_FOUND when they cannot. */
  readonly findMedia: (actor: PlanActor, mediaId: string) => MediaItem;
  /** "Tentar de novo" of a failed conversion, for masters. */
  readonly retryConversion: (actor: PlanActor, mediaId: string) => void;
  /** The names of a collection's speakers, by id (KBC-065). */
  readonly speakerNames: (topic: string) => ReadonlyMap<string, string>;
  readonly proposals: PlanProposals;
  /** The person who asked, as they stand now; null when they are gone. */
  readonly actorOf: (principal: string) => Promise<PlanActor | null>;
  readonly presence: () => Presence;
  readonly now?: () => Date;
  readonly onError?: (error: unknown, mediaId: string) => void;
}

/**
 * How far past what the person saw a run may be, reading the real words instead of the
 * length: above it the paid stage waits for a click (BR-4).
 */
export const ESTIMATE_TOLERANCE = 1.25;

/** Before anything was measured: the screen spec's own example, 4 and 3 min for 1 h 02. */
const DEFAULT_RATES = { transcribe: 4 / 62, speakers: 3 / 62 } as const;

const conflict = (message: string) =>
  new AppError('MEDIA_CONFLICT', message, {
    details: { reason: 'preparation' },
  });

const refuse = (options: PlanRefusals['options']) =>
  new AppError('PLAN_REFUSED', 'These options cannot be chosen', {
    details: { options },
  });

const minutesOf = (rate: number | null, fallback: number, ms?: number) =>
  ms === undefined ? null : Math.ceil(((rate ?? fallback) * ms) / 60_000);

const option = (
  refusal: OptionRefusal | null,
  extra: Partial<PreparationOption> = {},
): PreparationOption => ({ done: false, refusal, minutes: null, ...extra });

/**
 * The guided flow "Preparar áudio" (KBC-072): a recording's plan, the stage each request has
 * reached and the moves from one to the next. The work itself stays with the transcriber,
 * the separation and the proposals; this asks for each in turn.
 *
 * Money: a paid stage runs only from a person's choice with the value in sight, once, in
 * their name and while they may; it re-estimates, reserves only then, and anything past what
 * they saw waits for a click (BR-2, BR-4). Nothing it makes reaches listeners (BR-7).
 */
export class PreparationService {
  private readonly now: () => Date;
  /** Paid stages being taken now: they read as queued, not as interrupted. */
  private readonly starting = new Set<string>();

  constructor(private readonly deps: PreparationServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /* ---------- Choosing ---------- */

  /** What this person may ask, with the estimates for the length read in the browser. */
  async options(
    actor: PlanActor,
    query: PreparationOptionsQuery,
  ): Promise<PreparationOptions> {
    const item = query.mediaId
      ? this.deps.findMedia(actor, query.mediaId)
      : null;
    const durationMs = query.durationMs ?? item?.durationMs ?? undefined;
    const rates = this.deps.plans.measuredRates();
    const ai = await this.aiOption(actor, durationMs);
    return {
      options: {
        ...this.freeOptions({ actor, item, rates, durationMs }),
        ...this.trackOptions(actor, item, ai.option),
        subjects: option('unavailable'),
      },
      aiEstimateUsd: ai.estimateUsd,
      monthRemainingUsd: actor.canPropose
        ? this.deps.proposals.monthRemainingUsd()
        : null,
      ...presenceOf(this.deps.presence()),
    };
  }

  /** Tracks already approved stay as they are until someone reopens the edit. */
  private trackOptions(
    actor: PlanActor,
    item: MediaItem | null,
    ai: PreparationOption,
  ) {
    const done = item !== null && this.isApproved(item.id);
    const refusal = done ? ('approved' as const) : null;
    return {
      manual: option(refusal ?? this.handRefusal(actor), { done }),
      ai: { ...ai, refusal: refusal ?? ai.refusal, done },
    };
  }

  private handRefusal(actor: PlanActor): OptionRefusal | null {
    return actor.canEdit ? null : 'permission';
  }

  private freeOptions(input: {
    actor: PlanActor;
    item: MediaItem | null;
    rates: MeasuredRates;
    durationMs: number | undefined;
  }) {
    const { actor, item, rates, durationMs } = input;
    return {
      transcribe: option(null, {
        done: item?.transcription.version != null,
        minutes: minutesOf(
          rates.transcribe,
          DEFAULT_RATES.transcribe,
          durationMs,
        ),
      }),
      speakers: option(this.handRefusal(actor), {
        done: item !== null && this.hasVoices(item.id),
        minutes: minutesOf(rates.speakers, DEFAULT_RATES.speakers, durationMs),
      }),
    };
  }

  /** The paid option: what is true before the person ever looks at it (BR-3). */
  private async aiOption(
    actor: PlanActor,
    durationMs: number | undefined,
  ): Promise<{ option: PreparationOption; estimateUsd: number | null }> {
    const denied = { option: option('permission'), estimateUsd: null };
    if (!actor.canEdit || !actor.canPropose) return denied;
    const { proposals } = this.deps;
    if (!proposals.connected())
      return { option: option('not-connected'), estimateUsd: null };
    if (durationMs === undefined)
      return { option: option(null), estimateUsd: null };
    try {
      const { estimateUsd, refusal } =
        await proposals.estimateByDuration(durationMs);
      return { option: option(refusal), estimateUsd };
    } catch (err) {
      // Without the model's price there is no value to show, so no paid option either.
      this.deps.onError?.(err, '');
      return { option: option('not-connected'), estimateUsd: null };
    }
  }

  /** FR-1: a plan sent with an upload, with what the upload will have by then. */
  assertAllowed(actor: PlanActor, plan: PreparationPlan): void {
    this.assertPlan(plan, {
      canEdit: actor.canEdit,
      canPropose: actor.canPropose,
      hasTranscript: plan.transcribe,
      hasVoices: plan.speakers,
    });
  }

  private assertPlan(plan: PreparationPlan, context: PlanContext): void {
    const refused = planRefusals(plan, context);
    if (refused.length > 0) throw refuse(refused);
    if (plan.tracks !== 'ai') return;
    const { proposals } = this.deps;
    if (!proposals.connected())
      throw refuse([{ option: 'ai', refusal: 'not-connected' }]);
    if ((plan.acceptedUsd ?? 0) > proposals.monthRemainingUsd())
      throw refuse([{ option: 'ai', refusal: 'monthly-cap' }]);
  }

  /** Only "Transcrever" is today's upload and leaves no plan behind (AC-15). */
  record(actor: PlanActor, mediaId: string, plan: PreparationPlan): void {
    if (plan.transcribe && !isGuided(plan)) return;
    this.deps.plans.save({
      mediaId,
      principal: actor.principal,
      plan,
      finished: !isGuided(plan),
      now: this.now(),
    });
  }

  /** The plan of an audio already sent: only what is missing is asked (AC-16). */
  async start(
    actor: PlanActor,
    mediaId: string,
    asked: PreparationPlan,
  ): Promise<MediaPreparation> {
    const item = this.deps.findMedia(actor, mediaId);
    if (item.status !== 'ready')
      throw new AppError('MEDIA_NOT_READY', 'This media is not ready yet');
    if (this.isOpen(mediaId)) throw conflict('A preparation is already open');
    const plan = this.missingOf(actor, item, asked);
    this.deps.plans.save({
      mediaId,
      principal: actor.principal,
      plan,
      finished: false,
      now: this.now(),
    });
    if (plan.transcribe) this.requestTranscription(mediaId);
    return this.view(actor, mediaId);
  }

  /** What is asked of a recording, less what it has; checked against what it will have. */
  private missingOf(
    actor: PlanActor,
    item: MediaItem,
    asked: PreparationPlan,
  ): PreparationPlan {
    if (asked.tracks !== 'none' && this.isApproved(item.id))
      throw refuse([
        {
          option: asked.tracks === 'ai' ? 'ai' : 'manual',
          refusal: 'approved',
        },
      ]);
    const hasTranscript = item.transcription.version !== null;
    const hasVoices = this.hasVoices(item.id);
    const plan = {
      ...asked,
      transcribe: asked.transcribe && !hasTranscript,
      speakers: asked.speakers && !hasVoices,
    };
    this.assertPlan(plan, {
      canEdit: actor.canEdit,
      canPropose: actor.canPropose,
      hasTranscript: hasTranscript || plan.transcribe,
      hasVoices: hasVoices || plan.speakers,
    });
    return plan;
  }

  /* ---------- Going on ---------- */

  /** Every open plan takes its next step: the page need not be open (BR-8). */
  async advanceAll(): Promise<void> {
    for (const { mediaId } of this.deps.plans.listOpen())
      await this.advance(mediaId).catch((error: unknown) =>
        this.deps.onError?.(error, mediaId),
      );
  }

  /** Starts whatever is now possible, each stage at most once. */
  async advance(mediaId: string): Promise<void> {
    const record = this.deps.plans.get(mediaId);
    if (!record || record.finishedAt) return;
    if (record.validatingAt) {
      if (this.deps.edits.edit(mediaId)?.status === 'approved')
        this.deps.plans.finish(mediaId, this.now());
      return;
    }
    const [transcript] = this.deps.transcripts.transcripts(mediaId);
    if (!transcript) return;
    const { plan } = record;
    if (plan.speakers && !record.speakersAskedAt) this.askSpeakers(mediaId);
    if (plan.tracks === 'ai' && this.hasVoices(mediaId))
      await this.startProposal(record);
  }

  private askSpeakers(mediaId: string): void {
    if (this.deps.plans.claimSpeakers(mediaId, this.now()))
      this.deps.separation.request(mediaId);
  }

  /** The paid stage, once per plan: a failure never repeats by itself (BR-6). */
  private async startProposal(record: PreparationRecord): Promise<void> {
    const { mediaId } = record;
    if (!this.deps.plans.claimProposal(mediaId, this.now())) return;
    this.starting.add(mediaId);
    try {
      await this.runProposal(record);
    } catch (err) {
      this.stopProposal(mediaId, stopOf(err), null);
    } finally {
      this.starting.delete(mediaId);
    }
  }

  private async runProposal(record: PreparationRecord): Promise<void> {
    const { mediaId, plan } = record;
    const actor = await this.deps.actorOf(record.principal);
    if (!actor?.canEdit || !actor.canPropose)
      return this.stopProposal(mediaId, 'no-permission', null);
    const { proposals } = this.deps;
    const { estimateUsd, refusal } = await proposals.estimate(actor, mediaId);
    if (refusal) return this.stopProposal(mediaId, refusal, estimateUsd);
    const agreed = (plan.acceptedUsd ?? 0) * ESTIMATE_TOLERANCE;
    if (estimateUsd > agreed)
      return this.stopProposal(mediaId, 'estimate-rose', estimateUsd);
    await proposals.start(actor, mediaId);
  }

  private stopProposal(
    mediaId: string,
    stop: StageStop,
    usd: number | null,
  ): void {
    this.deps.plans.stopProposal({ mediaId, stop, usd, now: this.now() });
  }

  /** "Tentar de novo": redoes what failed; what waited for it follows by itself (BR-6). */
  async retry(
    actor: PlanActor,
    mediaId: string,
    stage: RetryStage,
  ): Promise<MediaPreparation> {
    const current = await this.view(actor, mediaId);
    const found = current.stages.find((one) => one.stage === stage);
    if (!found?.canRetry) throw conflict('This stage cannot be retried now');
    if (stage === 'convert') this.deps.retryConversion(actor, mediaId);
    if (stage === 'transcribe') this.requestTranscription(mediaId);
    if (stage === 'speakers') this.deps.separation.request(mediaId);
    if (stage === 'tracks') await this.retryProposal(actor, mediaId);
    return this.view(actor, mediaId);
  }

  /** The person's click, seeing the value, is what pays; refusals are shown, not thrown. */
  private async retryProposal(
    actor: PlanActor,
    mediaId: string,
  ): Promise<void> {
    this.deps.plans.reclaimProposal(mediaId, this.now());
    this.starting.add(mediaId);
    try {
      await this.deps.proposals.start(actor, mediaId);
    } catch (err) {
      this.stopProposal(mediaId, stopOf(err), null);
    } finally {
      this.starting.delete(mediaId);
    }
  }

  /** "Marcar as faixas eu mesmo": from a proposal that did not run to step 3 (BR-6). */
  async switchToManual(
    actor: PlanActor,
    mediaId: string,
  ): Promise<MediaPreparation> {
    const current = await this.view(actor, mediaId);
    if (!current.canSwitchToManual)
      throw conflict('The proposal cannot be switched now');
    this.deps.plans.chooseTracks(mediaId, 'manual', this.now());
    return this.view(actor, mediaId);
  }

  /** "Validar faixas" or "Concluir": only a person moves past step 2 (FR-5). */
  async next(actor: PlanActor, mediaId: string): Promise<MediaPreparation> {
    const current = await this.view(actor, mediaId);
    if (current.next === 'conclude')
      this.deps.plans.finish(mediaId, this.now());
    else if (current.next === 'validate')
      this.deps.plans.startValidating(mediaId, this.now());
    else throw conflict('Nothing to move on to yet');
    return this.view(actor, mediaId);
  }

  /* ---------- Reading ---------- */

  /** Where each open preparation stopped, for the lists and the audio's page (FR-6). */
  listOpen(actor: PlanActor): OpenPreparations {
    const items = this.deps.plans.listOpen().flatMap((record) => {
      const item = this.visibleItem(actor, record.mediaId);
      if (!item || item.status === 'uploading') return [];
      const step = this.stepOf(record, item);
      return step === 4 ? [] : [{ mediaId: item.id, step }];
    });
    return { items };
  }

  private visibleItem(actor: PlanActor, mediaId: string): MediaItem | null {
    try {
      return this.deps.findMedia(actor, mediaId);
    } catch (err) {
      if (err instanceof AppError && err.code === 'MEDIA_NOT_FOUND')
        return null;
      throw err;
    }
  }

  /** FR-2. Reading also moves the plan on, so an open page is never behind the janitor. */
  async view(actor: PlanActor, mediaId: string): Promise<MediaPreparation> {
    this.deps.findMedia(actor, mediaId);
    await this.advance(mediaId);
    const item = this.deps.findMedia(actor, mediaId);
    const record = this.deps.plans.get(mediaId);
    const draft = this.deps.drafts.draft(mediaId);
    const speakers = this.speakersOf(mediaId);
    const stages = record
      ? await this.stagesFor(actor, { record, item, draft })
      : [];
    const open = record !== null && record.finishedAt === null;
    return {
      mediaId,
      ...detailsOf(item),
      step: record ? this.stepOf(record, item) : 1,
      skipped: record?.plan.tracks === 'none',
      finished: record?.finishedAt != null,
      plan: record?.plan ?? null,
      stages,
      separation: speakers?.version ?? null,
      voices: voicesOf(speakers),
      suggestions: suggestionsOf(draft.voices, speakers),
      tracks: this.tracksOf({ item, draft, speakers }),
      next:
        open && !record.validatingAt ? nextActionOf(record.plan, stages) : null,
      canSwitchToManual: open && switchable(record.plan, stages),
      ...presenceOf(this.deps.presence()),
    };
  }

  private speakersOf(mediaId: string): TranscriptSpeakers | null {
    const [transcript] = this.deps.transcripts.transcripts(mediaId);
    return transcript
      ? (this.deps.separation.voicesOn(mediaId, transcript)?.speakers ?? null)
      : null;
  }

  /** A paid stage that failed is read again: what a click would pay changes with the world. */
  private async stagesFor(
    actor: PlanActor,
    input: StageInput,
  ): Promise<PreparationStage[]> {
    const facts = this.factsOf(actor, input);
    const stages = stagesOf(facts);
    const paidFailed = stages.some(
      ({ stage, state }) => stage === 'tracks' && state === 'failed',
    );
    if (!paidFailed || !facts.canPropose) return stages;
    const paidNow = await this.paidStageNow(actor, input.item.id);
    return stagesOf({ ...facts, paidNow });
  }

  private async paidStageNow(
    actor: PlanActor,
    mediaId: string,
  ): Promise<PaidStageNow | null> {
    try {
      const { estimateUsd, refusal } = await this.deps.proposals.estimate(
        actor,
        mediaId,
      );
      return { estimateUsd, allowed: refusal === null };
    } catch (err) {
      // No estimate now (the AI off, its price out of reach): the failure as it was stands.
      if (!(err instanceof AppError)) this.deps.onError?.(err, mediaId);
      return null;
    }
  }

  private factsOf(actor: PlanActor, input: StageInput): StageFacts {
    const { record, item, draft } = input;
    const { plans, separation } = this.deps;
    const { mediaId, proposalClaimedAt } = record;
    return {
      plan: record.plan,
      item,
      separation: separation.status(mediaId),
      hasVoices: this.hasVoices(mediaId),
      claimed: proposalClaimedAt !== null,
      starting: this.starting.has(mediaId),
      stop: record.proposalStop,
      stopUsd: record.proposalStopUsd,
      run: ownRun(draft.run, proposalClaimedAt),
      attempt: this.failedAttemptOf(mediaId),
      runFailure: proposalClaimedAt === null ? null : draft.lastFailure,
      cuts: plans.runningCuts(mediaId),
      ahead: {
        transcribe: plans.jobsAhead(mediaId, 'transcribe'),
        speakers: plans.jobsAhead(mediaId, 'diarize'),
      },
      canPropose: actor.canEdit && actor.canPropose,
      paidNow: null,
    };
  }

  private failedAttemptOf(mediaId: string): FailedAttempt | null {
    const [transcript] = this.deps.transcripts.transcripts(mediaId);
    return transcript
      ? this.deps.drafts.failedAttempt(mediaId, transcript.id)
      : null;
  }

  /** Server state, so reloading or another device lands on the same step (BR-8). */
  private stepOf(record: PreparationRecord, item: MediaItem): PreparationStep {
    if (item.status === 'uploading') return 1;
    if (record.finishedAt) return 4;
    if (!record.validatingAt) return 2;
    return this.deps.edits.edit(item.id)?.status === 'approved' ? 4 : 3;
  }

  private tracksOf(input: {
    item: MediaItem;
    draft: DraftTracks;
    speakers: TranscriptSpeakers | null;
  }): PreparationTrack[] {
    const { item, draft, speakers } = input;
    const approved = this.deps.edits.edit(item.id)?.status === 'approved';
    const names = this.deps.speakerNames(item.topic);
    const person = (speakerId: string | null, voice: number | null) =>
      personOf({ speakerId, voice, names, speakers, voices: draft.voices });
    return draft.tracks.map((track) => ({
      id: track.id,
      title: track.title,
      startMs: track.startMs,
      endMs: track.endMs,
      asker: person(track.askerSpeakerId, track.askerVoice),
      answerer: person(track.answererSpeakerId, track.answererVoice),
      status: statusOf(track, approved),
    }));
  }

  private isApproved(mediaId: string): boolean {
    return this.deps.edits.edit(mediaId)?.status === 'approved';
  }

  private isOpen(mediaId: string): boolean {
    const record = this.deps.plans.get(mediaId);
    return record !== null && record.finishedAt === null;
  }

  private hasVoices(mediaId: string): boolean {
    const [transcript] = this.deps.transcripts.transcripts(mediaId);
    return (
      transcript !== undefined &&
      this.deps.separation.voicesOn(mediaId, transcript) !== null
    );
  }

  private requestTranscription(mediaId: string): void {
    this.deps.transcripts.requestTranscription({
      mediaId,
      jobId: randomUUID(),
      now: this.now(),
    });
  }
}

/** What a plan's stages are read from. */
interface StageInput {
  readonly record: PreparationRecord;
  readonly item: MediaItem;
  readonly draft: DraftTracks;
}

const detailsOf = ({ title, topic, author }: MediaItem) => ({
  title,
  topic,
  author: author?.name ?? null,
});

const presenceOf = ({ transcriber, offSince }: Presence) => ({
  transcriber,
  transcriberOffSince: offSince,
});

/** The run this plan started; an older one is not its progress. */
const ownRun = (
  run: ProposalRun | null,
  claimedAt: string | null,
): ProposalRun | null =>
  claimedAt !== null && run !== null && run.createdAt >= claimedAt ? run : null;

const statusOf = (
  track: DraftTrack,
  approved: boolean,
): PreparationTrack['status'] => {
  if (approved) return 'approved';
  return track.source === 'ai' && !track.edited ? 'proposed' : 'manual';
};

/** The AI failed, or waits for a stage that did: from there a person may mark by hand. */
function switchable(
  plan: PreparationPlan,
  stages: MediaPreparation['stages'],
): boolean {
  const tracks = stages.find(({ stage }) => stage === 'tracks');
  return (
    plan.tracks === 'ai' &&
    (tracks?.state === 'failed' || tracks?.state === 'blocked')
  );
}

function voicesOf(speakers: TranscriptSpeakers | null): PreparationVoice[] {
  if (!speakers) return [];
  return speakers.voices.map(({ voice, speakingMs }) => {
    const label = speakers.labels.find((one) => one.voice === voice);
    return {
      voice,
      speakingMs,
      name: label?.name ?? null,
      audience: label?.kind === 'audience',
    };
  });
}

/** Only for a voice nobody named yet: a suggestion waits for a person (KBC-067 BR-5). */
function suggestionsOf(
  suggestions: readonly VoiceSuggestion[],
  speakers: TranscriptSpeakers | null,
): VoiceSuggestion[] {
  return suggestions.filter(
    ({ voice }) =>
      speakers?.labels.find((one) => one.voice === voice)?.kind !== 'person',
  );
}

/** A name a person chose wins, then who the voice is, then the AI's suggestion. */
function personOf(input: {
  speakerId: string | null;
  voice: number | null;
  names: ReadonlyMap<string, string>;
  speakers: TranscriptSpeakers | null;
  voices: readonly VoiceSuggestion[];
}): TrackPerson | null {
  const { speakerId, voice, names, speakers, voices } = input;
  if (speakerId === null && voice === null) return null;
  const chosen = speakerId === null ? undefined : names.get(speakerId);
  if (chosen) return { name: chosen, voice, audience: false };
  const label = speakers?.labels.find((one) => one.voice === voice);
  if (label && label.kind !== 'unnamed')
    return { name: label.name, voice, audience: label.kind === 'audience' };
  const suggestion = voices.find((one) => one.voice === voice);
  return {
    name: suggestion?.name ?? null,
    voice,
    audience: suggestion?.audience ?? false,
  };
}
