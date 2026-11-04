import type {
  JobCuts,
  PreparationPlan,
  StageStop,
  TrackChoice,
} from '@kb-chat/contracts';

/** A recording's plan, with what the stages' own records cannot say. */
export interface PreparationRecord {
  readonly mediaId: string;
  /** Who asked: a paid stage runs in their name (BR-4). */
  readonly principal: string;
  readonly plan: PreparationPlan;
  readonly speakersAskedAt: string | null;
  /** When the paid stage was taken: once, so a failure never repeats by itself. */
  readonly proposalClaimedAt: string | null;
  readonly proposalStop: StageStop | null;
  readonly proposalStopUsd: number | null;
  /** The person pressed "Validar faixas" (FR-5). */
  readonly validatingAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
}

/** Machine time per millisecond of audio, measured on what was done; null before any. */
export interface MeasuredRates {
  readonly transcribe: number | null;
  readonly speakers: number | null;
}

/** A job the queue shows: a conversion, transcription or separation not finished. */
export interface ActiveJob {
  readonly mediaId: string;
  readonly kind: 'transcode' | 'transcribe' | 'diarize';
  readonly status: 'queued' | 'leased';
}

/**
 * The guided flow's plans (KBC-072, migration media-preparations). The claims answer false
 * to whoever comes second, so two reads never start one stage twice.
 */
export interface PreparationStorePort {
  get(mediaId: string): PreparationRecord | null;
  /** Every plan not finished. */
  listOpen(): PreparationRecord[];
  /** Writes the plan; a finished one of the same recording is replaced. */
  save(input: {
    readonly mediaId: string;
    readonly principal: string;
    readonly plan: PreparationPlan;
    readonly finished: boolean;
    readonly now: Date;
  }): void;
  claimSpeakers(mediaId: string, now: Date): boolean;
  claimProposal(mediaId: string, now: Date): boolean;
  /** The paid stage did not run, and why. */
  stopProposal(input: {
    readonly mediaId: string;
    readonly stop: StageStop;
    readonly usd: number | null;
    readonly now: Date;
  }): void;
  /** The paid stage is taken again from this moment, by the run that won it: no stop stands. */
  reclaimProposal(mediaId: string, at: Date): void;
  /** Changes the choice, dropping what stopped the AI (BR-6). */
  chooseTracks(mediaId: string, tracks: TrackChoice, now: Date): void;
  startValidating(mediaId: string, now: Date): void;
  finish(mediaId: string, now: Date): void;
  /** The cuts of the job transcribing now; null for none or an older transcriber. */
  runningCuts(mediaId: string): JobCuts | null;
  /** Jobs of this kind waiting or running before this recording's. */
  jobsAhead(mediaId: string, kind: 'transcribe' | 'diarize'): number;
  /** The jobs not finished, in the order the workers take them (FIFO, ADR 0022). */
  activeJobs(): ActiveJob[];
  /** Recordings whose conversion or newest transcription failed. */
  failedRecordings(): string[];
  measuredRates(): MeasuredRates;
}
