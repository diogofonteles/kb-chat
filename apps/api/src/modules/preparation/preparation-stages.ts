import { spendCapSchema } from '@kb-chat/contracts';
import type {
  ApiErrorCode,
  DiarizationStatus,
  JobCuts,
  MediaItem,
  NextAction,
  PreparationPlan,
  PreparationStage,
  PreparationStageId,
  ProposalFailure,
  ProposalRun,
  StageFailure,
  StageState,
  StageStop,
} from '@kb-chat/contracts';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { FailedAttempt } from '../../ports/track-proposal-store.js';

/** All a plan's stages are read from: the records of the work, never a copy of them. */
export interface StageFacts {
  readonly plan: PreparationPlan;
  readonly item: Pick<
    MediaItem,
    'status' | 'progress' | 'failure' | 'canRetry' | 'transcription'
  >;
  readonly separation: DiarizationStatus;
  readonly hasVoices: boolean;
  /** The paid stage was taken by a person's plan or click. */
  readonly claimed: boolean;
  /** The moment of taking it is going on in this process. */
  readonly starting: boolean;
  readonly stop: StageStop | null;
  readonly stopUsd: number | null;
  /** The run of this plan; an older one is not its progress. */
  readonly run: ProposalRun | null;
  /** The analysis a failed run left open; its spend counts with or without a window. */
  readonly attempt: FailedAttempt | null;
  readonly runFailure: ProposalFailure | null;
  readonly cuts: JobCuts | null;
  readonly ahead: { readonly transcribe: number; readonly speakers: number };
  readonly canPropose: boolean;
  /** What pressing "Tentar de novo" on the paid stage meets now; null when unknown. */
  readonly paidNow: PaidStageNow | null;
}

/** The paid stage read again, as it stands now. */
export interface PaidStageNow {
  /** What is left to pay for: the windows a failed run did not finish. */
  readonly estimateUsd: number;
  readonly allowed: boolean;
}

const BLANK = {
  percent: null,
  cuts: null,
  ahead: null,
  blockedBy: null,
  failure: null,
  canRetry: false,
  windows: null,
  reservedUsd: null,
  spentUsd: null,
  estimateUsd: null,
} as const;

const stageOf = (
  stage: PreparationStageId,
  state: StageState,
  extra: Partial<PreparationStage> = {},
): PreparationStage => ({ ...BLANK, stage, state, ...extra });

/** What came before: the stage that failed or stands in the way, if any. */
interface Upstream {
  readonly stage: PreparationStageId;
  readonly state: StageState;
  readonly blockedBy: PreparationStageId | null;
}

const blockerOf = (before: Upstream): PreparationStageId | null =>
  before.state === 'failed' ? before.stage : before.blockedBy;

/** Before its turn: waiting for the one before, or blocked by the one that failed (BR-6). */
function notYet(
  stage: PreparationStageId,
  before: Upstream,
): PreparationStage | null {
  const blockedBy = blockerOf(before);
  if (blockedBy) return stageOf(stage, 'blocked', { blockedBy });
  return before.state === 'done' ? null : stageOf(stage, 'waiting');
}

const UPLOADED = new Set(['queued', 'processing', 'ready', 'failed']);

function uploadStage({ item }: StageFacts): PreparationStage {
  return stageOf('upload', UPLOADED.has(item.status) ? 'done' : 'running');
}

const CONVERT_STATES: Record<MediaItem['status'], StageState> = {
  uploading: 'waiting',
  queued: 'queued',
  processing: 'running',
  ready: 'done',
  failed: 'failed',
};

function convertStage({ item }: StageFacts): PreparationStage {
  return stageOf('convert', CONVERT_STATES[item.status], {
    percent: item.status === 'processing' ? item.progress : null,
    failure: item.status === 'failed' ? 'work' : null,
    canRetry: item.status === 'failed' && item.canRetry,
  });
}

const percentOf = (cuts: JobCuts | null): number | null =>
  cuts === null ? null : Math.floor((cuts.done * 100) / cuts.total);

function transcribeStage(
  facts: StageFacts,
  before: Upstream,
): PreparationStage {
  const waiting = notYet('transcribe', before);
  if (waiting) return waiting;
  const { status } = facts.item.transcription;
  if (status === 'done') return stageOf('transcribe', 'done');
  if (status === 'failed')
    return stageOf('transcribe', 'failed', {
      failure: 'work',
      canRetry: true,
    });
  if (status === 'transcribing')
    return stageOf('transcribe', 'running', {
      cuts: facts.cuts,
      percent: percentOf(facts.cuts),
    });
  return stageOf('transcribe', 'queued', { ahead: facts.ahead.transcribe });
}

function speakersStage(facts: StageFacts, before: Upstream): PreparationStage {
  const waiting = notYet('speakers', before);
  if (waiting) return waiting;
  if (facts.separation === 'failed')
    return stageOf('speakers', 'failed', { failure: 'work', canRetry: true });
  if (facts.separation === 'diarizing') return stageOf('speakers', 'running');
  if (facts.separation === 'done') return stageOf('speakers', 'done');
  return stageOf('speakers', 'queued', { ahead: facts.ahead.speakers });
}

const spendCapDetails = z.object({ cap: spendCapSchema });

/** Who asked lost the recording; the rest is the recording's own state, not the provider. */
const STOP_BY_CODE: Partial<Record<ApiErrorCode, StageStop>> = {
  LLM_NOT_CONFIGURED: 'not-connected',
  MEDIA_NOT_FOUND: 'no-permission',
  MEDIA_CONFLICT: 'conflict',
  MEDIA_NOT_READY: 'conflict',
};

/** Why the paid stage did not start, in the words the screen has for it. */
export function stopOf(error: unknown): StageStop {
  if (!(error instanceof AppError)) return 'provider-unavailable';
  if (error.code === 'MEDIA_SPEND_CAP')
    return spendCapDetails.parse(error.details).cap;
  return STOP_BY_CODE[error.code] ?? 'provider-unavailable';
}

/**
 * A failure a click cannot get past while it lasts: money, a permission or the AI's connection.
 * These are read again (`paidNow`), and the click still meets the caps when it starts.
 */
const FINAL_FAILURES: ReadonlySet<StageFailure> = new Set([
  'run-cap',
  'monthly-cap',
  'no-permission',
  'not-connected',
]);

/** What failed attempts left: finished windows stay, and so does all they cost (BR-6). */
function leftByFailedRuns({ attempt }: StageFacts): Partial<PreparationStage> {
  if (!attempt || (attempt.windowsDone === 0 && attempt.spentUsd === 0))
    return {};
  return {
    windows: { done: attempt.windowsDone, total: attempt.windowsTotal },
    spentUsd: attempt.spentUsd,
  };
}

function failedTracks(
  facts: StageFacts,
  failure: StageFailure,
): PreparationStage {
  const { plan, stopUsd, paidNow } = facts;
  return stageOf('tracks', 'failed', {
    ...leftByFailedRuns(facts),
    failure,
    canRetry:
      facts.canPropose &&
      (!FINAL_FAILURES.has(failure) || paidNow?.allowed === true),
    estimateUsd: paidNow?.estimateUsd ?? stopUsd ?? plan.acceptedUsd,
  });
}

function runningTracks(run: ProposalRun, state: StageState): PreparationStage {
  return stageOf('tracks', state, {
    percent: Math.floor((run.windowsDone * 100) / run.windowsTotal),
    windows: { done: run.windowsDone, total: run.windowsTotal },
    reservedUsd: run.estimateUsd,
    spentUsd: run.spentUsd,
  });
}

function tracksStage(facts: StageFacts, before: Upstream): PreparationStage {
  if (facts.starting) return stageOf('tracks', 'queued');
  if (facts.stop) return failedTracks(facts, facts.stop);
  if (facts.run?.status === 'running')
    return runningTracks(facts.run, 'running');
  if (facts.runFailure) return failedTracks(facts, facts.runFailure);
  if (facts.run?.status === 'done') return runningTracks(facts.run, 'done');
  // Taken and neither started nor stopped: the API went down in between.
  if (facts.claimed) return failedTracks(facts, 'interrupted');
  return notYet('tracks', before) ?? stageOf('tracks', 'queued');
}

/** The stages of a plan, in order; the ones nobody asked for are not there (AC-16). */
export function stagesOf(facts: StageFacts): PreparationStage[] {
  const { plan } = facts;
  const stages = [uploadStage(facts), convertStage(facts)];
  const last = (): Upstream => {
    const stage = stages.at(-1);
    return stage ?? { stage: 'upload', state: 'done', blockedBy: null };
  };
  if (plan.transcribe) stages.push(transcribeStage(facts, last()));
  if (plan.speakers) stages.push(speakersStage(facts, last()));
  if (plan.tracks === 'ai') stages.push(tracksStage(facts, last()));
  return stages;
}

const SETTLED: ReadonlySet<StageState> = new Set(['done', 'failed', 'blocked']);

const isDone = (
  stages: readonly PreparationStage[],
  id: PreparationStageId,
): boolean => {
  const found = stages.find(({ stage }) => stage === id);
  return found === undefined || found.state === 'done';
};

/**
 * What the person can press once nothing is left to process (BR-5): "Validar faixas" needs
 * the transcript and the tracks' stage; voices that failed stop only the AI, which needs them.
 */
export function nextActionOf(
  plan: PreparationPlan,
  stages: readonly PreparationStage[],
): NextAction | null {
  const settled = stages.every(({ state }) => SETTLED.has(state));
  if (!settled || !isDone(stages, 'convert')) return null;
  if (!isDone(stages, 'transcribe') || !isDone(stages, 'tracks')) return null;
  return plan.tracks === 'none' ? 'conclude' : 'validate';
}
