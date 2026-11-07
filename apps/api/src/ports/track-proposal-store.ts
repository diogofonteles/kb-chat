import type {
  DraftTrack,
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
  /** The most the run may spend (KBC-112 BR-1); it is also what is reserved. */
  readonly limitUsd: number;
  readonly now: Date;
  /** What the failed attempts before it spent: the run cap holds over the whole analysis. */
  readonly carriedUsd: number;
  /** The failed run it goes on from: its output moves here (KBC-072 BR-6). */
  readonly resumes: Pick<FailedAttempt, 'runId' | 'windowsDone'> | null;
}

/** How an analysis stands after a failed attempt: where it got to and all it has spent. */
export interface FailedAttempt {
  readonly runId: string;
  readonly windowsDone: number;
  readonly windowsTotal: number;
  /** Over every attempt so far, finished windows or not. */
  readonly spentUsd: number;
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
  /** Where the continued track starts: it, and no other, is stretched. */
  readonly startMs: number;
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
/** A name a run suggested and where its text stands. */
export interface VoiceText {
  readonly runId: string;
  readonly voice: number;
  readonly name: string;
  /** Null until a correction changed the text. */
  readonly written: string | null;
}

export interface TrackProposalStorePort {
  /**
   * Starts a run, one that goes on from a failed one taking its tracks and names along; null
   * when the recording already has one running.
   */
  startRun(run: NewProposalRun): ProposalRun | null;
  getRun(runId: string): ProposalRun | null;
  /** The recording's newest run, whatever became of it. */
  newestRun(mediaId: string): ProposalRun | null;
  /** The recording's newest run when it failed on this transcript: the analysis still open. */
  failedAttempt(mediaId: string, transcriptId: string): FailedAttempt | null;
  /** What the newest run suggested for each voice and what its words say now (KBC-090). */
  voiceTexts(mediaId: string): VoiceText[];
  /** The name the AI's words say now, once a person's took the place of the suggested one. */
  markWritten(runId: string, voice: number, name: string): void;
  /** The tracks a run has written, in order. */
  runTracks(runId: string): DraftTrack[];
  /**
   * One window's result, in one transaction: tracks, voice names, progress and spend.
   * `spentUsd` is what this run spent, without what it carried from a failed one. Returns
   * false when `extendLast` found no track of the run to stretch (it went meanwhile).
   */
  saveWindow(input: {
    readonly runId: string;
    readonly extendLast: TrackExtension | null;
    readonly tracks: readonly ProposedTrack[];
    readonly voices: readonly VoiceSuggestion[];
    readonly spentUsd: number;
  }): boolean;
  /**
   * Ends a run and its ledger reservation in one transaction. Done: the older untouched AI
   * tracks of the recording go (BR-6) and the spend is settled; those on screen that nothing
   * took the place of stay, as the new run's (KBC-097). Failed: what its finished windows
   * wrote stays, paid for, and the unspent part is refunded (FR-5, KBC-072 BR-6); taking the
   * screen from an earlier failed run, it keeps that run's tracks the same way. The
   * reservation is closed even when the recording, and so the run, was deleted meanwhile.
   */
  finishRun(input: {
    readonly runId: string;
    readonly spendId: string;
    readonly failure: ProposalFailure | null;
    readonly spentUsd: number;
    readonly now: Date;
  }): void;
  /** Ranges a new proposal must leave alone: a person's tracks and edited ones (BR-6). */
  keptRanges(mediaId: string): KeptRange[];
  /** The edit stands approved: nothing to propose on until it is reopened (BR-9). */
  isApproved(mediaId: string): boolean;
  /**
   * The draft now: the newest run that did not fail or, with none, the newest failed one that
   * finished windows; its tracks and the kept ones.
   */
  draft(mediaId: string): DraftTracks;
  /**
   * Closes the runs a stopped API left running: as failed (`interrupted`), keeping their
   * finished windows, or as done when only the closing was missing.
   */
  interruptRunning(now: Date): InterruptedRun[];
}
