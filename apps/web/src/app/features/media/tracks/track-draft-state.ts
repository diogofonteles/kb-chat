import { HttpErrorResponse } from '@angular/common/http';
import {
  apiErrorSchema,
  inTimeOrder,
  trackProblemsDetailsSchema,
  type DraftTrack,
  type EditTrack,
  type MediaEdit,
  type TrackProblem,
} from '@kb-chat/contracts';
import { z } from 'zod';

type Timer = ReturnType<typeof setTimeout>;

const estimateRoseSchema = z.object({
  reason: z.literal('estimate-rose'),
  estimateUsd: z.number(),
});

/** What a save came to; only `saved` lets an action go on (BR-1). */
export type SaveResult =
  'saved' | 'conflict' | 'failed' | 'offline' | 'invalid';

/** Why this draft cannot be written until it is read again (FR-10). */
export type ConflictReason =
  'stale' | 'approved' | 'proposal-running' | 'preparation';

/** What a person pressed, while it runs; it is never stored for later. */
export type DraftAction = 'approve' | 'propose';

/**
 * Where the draft is: one state, so that no combination of flags can say two things. A
 * `saving` with a `lock` is a press waiting on that save: nothing can be changed meanwhile.
 * Only the states with a `timer` have one running.
 */
export type DraftPhase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unreadable'; readonly error: unknown }
  /** The server has what is on screen; `saved`: because of a save just now. */
  | { readonly kind: 'clean'; readonly saved: boolean }
  | { readonly kind: 'pending'; readonly timer: Timer }
  | {
      readonly kind: 'saving';
      /** The screen moved on from what was sent. */
      readonly changed: boolean;
      readonly lock: DraftAction | null;
    }
  /** `kept`: the journal has the changes, so they survive this page. */
  | {
      readonly kind: 'offline';
      readonly timer: Timer | null;
      readonly kept: boolean;
    }
  | { readonly kind: 'conflict'; readonly reason: ConflictReason }
  | { readonly kind: 'failed' }
  /** Refused for its tracks: the same `timing` would be refused again, so it waits (KBC-094). */
  | {
      readonly kind: 'invalid';
      readonly problems: readonly TrackProblem[];
      readonly timing: string;
    }
  | { readonly kind: 'applying'; readonly action: DraftAction };

/** Whether a person can change the tracks in each state (KBC-067 FR-3, UP-06). */
export const EDITABLE: Readonly<Record<DraftPhase['kind'], boolean>> = {
  loading: false,
  unreadable: false,
  clean: true,
  pending: true,
  saving: true,
  offline: true,
  conflict: false,
  failed: true,
  invalid: true,
  applying: false,
};

/** "Aprovar faixas" pressed: applied, or why not; nothing happens later on its own. */
export type ApproveResult =
  | { readonly kind: 'approved' }
  | { readonly kind: 'invalid'; readonly problems: readonly TrackProblem[] }
  | { readonly kind: 'stopped'; readonly result: SaveResult }
  | { readonly kind: 'refused'; readonly error: unknown };

/** "Confirmar e propor" pressed: started, or why not (KBC-067 BR-2). */
export type ProposeResult =
  | { readonly kind: 'started' }
  | { readonly kind: 'stopped'; readonly result: SaveResult }
  | { readonly kind: 'refused'; readonly error: unknown };

/** The answer was lost: the write may or may not have arrived (I-4). */
export const isUncertain = (status: number): boolean =>
  status === 0 || status === 502 || status === 504;

export const toEditTrack = (track: DraftTrack) => ({
  id: track.id,
  source: track.source,
  startMs: track.startMs,
  endMs: track.endMs,
  kind: track.kind,
  title: track.title,
  askerVoice: track.askerVoice,
  answererVoice: track.answererVoice,
  askerSpeakerId: track.askerSpeakerId,
  answererSpeakerId: track.answererSpeakerId,
});

const comparable = (tracks: readonly DraftTrack[]): readonly EditTrack[] =>
  inTimeOrder(tracks).map(toEditTrack);

/** The same draft as a person sees it, whatever the order or the server's own fields. */
export const sameTracks = (
  a: readonly DraftTrack[],
  b: readonly DraftTrack[],
): boolean => JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));

/** What a save's refusal depends on: a title or a person changes nothing about it. */
export const timingOf = (tracks: readonly DraftTrack[]): string =>
  JSON.stringify(
    inTimeOrder(tracks).map(({ id, startMs, endMs }) => [id, startMs, endMs]),
  );

export const statusOf = (err: unknown): number =>
  err instanceof HttpErrorResponse ? err.status : -1;

const detailsOf = (err: unknown): unknown =>
  err instanceof HttpErrorResponse
    ? apiErrorSchema.safeParse(err.error).data?.error.details
    : undefined;

/** The answer's own code, for what a status alone does not say. */
export function problemsOf(err: unknown): readonly TrackProblem[] {
  const details = trackProblemsDetailsSchema.safeParse(detailsOf(err));
  return details.success ? details.data.problems : [];
}

/** A 409 says what stands in the way (`details.reason`). */
export function conflictOf(err: unknown): ConflictReason {
  const details = detailsOf(err);
  const reason =
    typeof details === 'object' && details !== null && 'reason' in details
      ? details.reason
      : null;
  return reason === 'proposal-running' || reason === 'preparation'
    ? reason
    : 'approved';
}

/** The run would cost more than the value confirmed: the value it would cost now. */
export function roseEstimateOf(err: unknown): number | null {
  const details = estimateRoseSchema.safeParse(detailsOf(err));
  return details.success ? details.data.estimateUsd : null;
}

/** What keeps a draft read from the server from taking changes now. */
export function blockerOf(edit: MediaEdit): ConflictReason | null {
  if (edit.status === 'approved') return 'approved';
  return edit.run?.status === 'running' ? 'proposal-running' : null;
}
