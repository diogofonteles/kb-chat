import type {
  DraftTracks,
  ProposalFailure,
  ProposalRun,
  TrackKind,
  VoiceSuggestion,
} from '@kb-chat/contracts';

/** A run as it starts (KBC-067 FR-1): its windows are known, none done yet. */
export interface NewProposalRun {
  readonly id: string;
  readonly mediaId: string;
  readonly transcriptId: string;
  readonly principal: string;
  readonly model: string;
  /** The media ledger reservation it spends from. */
  readonly spendId: string;
  readonly windowsTotal: number;
  readonly estimateUsd: number;
  readonly now: Date;
}

/** A track a window proposed, already checked (segments, times, title). */
export interface ProposedTrack {
  readonly firstSegment: number;
  readonly lastSegment: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly kind: TrackKind;
  readonly title: string | null;
  readonly askerVoice: number | null;
  readonly answererVoice: number | null;
}

/** The new end of the run's last track when a window's first track continues it. */
export interface TrackExtension {
  readonly lastSegment: number;
  readonly endMs: number;
}

/** A range of the recording a proposal may not cross: a person's or an edited track. */
export interface KeptRange {
  readonly startMs: number;
  readonly endMs: number;
}

/** A run that was running when the API stopped, as the restart closes it. */
export interface InterruptedRun {
  readonly runId: string;
  readonly spendId: string;
  readonly spentUsd: number;
}

/**
 * The AI's proposal runs and the draft tracks they write (KBC-067, ADR 0029 §4), in the
 * media database. Each window's tracks are written as the window ends (FR-3), so the
 * draft grows while the run goes on (KBC-072).
 */
export interface TrackProposalStorePort {
  /** Starts a run; null when the recording already has one running. */
  startRun(run: NewProposalRun): ProposalRun | null;
  getRun(runId: string): ProposalRun | null;
  /** The ledger reservation of a run. */
  spendIdOf(runId: string): string | null;
  /** One window's result, in one transaction: tracks, voice names, progress and spend. */
  saveWindow(input: {
    readonly runId: string;
    readonly extendLast: TrackExtension | null;
    readonly tracks: readonly ProposedTrack[];
    readonly voices: readonly VoiceSuggestion[];
    readonly spentUsd: number;
  }): void;
  /**
   * Ends a run. Done: the older untouched AI tracks of the recording go (BR-6). Failed: this
   * run's tracks and names go, and the draft is what it was before (FR-5).
   */
  finishRun(input: {
    readonly runId: string;
    readonly failure: ProposalFailure | null;
    readonly spentUsd: number;
    readonly now: Date;
  }): void;
  /** Ranges a new proposal must leave alone: a person's tracks and edited ones (BR-6). */
  keptRanges(mediaId: string): KeptRange[];
  /** The draft now: the newest run that did not fail, its tracks and the kept ones. */
  draft(mediaId: string): DraftTracks;
  /** Closes the runs a stopped API left running, as failed (`interrupted`). */
  interruptRunning(now: Date): InterruptedRun[];
}
