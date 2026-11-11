import type { PreparationPlanRequest, TrackChoice } from '@kb-chat/contracts';

/** What the person ticked in "O que fazer com este áudio". */
export interface PlanChoices {
  readonly transcribe: boolean;
  readonly speakers: boolean;
  readonly tracks: TrackChoice;
  readonly subjects: boolean;
}

const STORAGE_KEY = 'kb-chat.preparation-choices';

/** BR-2: nothing that costs money comes ticked. */
export const defaultChoices = (canEdit: boolean): PlanChoices => ({
  transcribe: true,
  speakers: canEdit,
  tracks: 'none',
  subjects: false,
});

/** What unticking takes with it, with what the notice says (BR-3). */
export type DroppedBy = 'transcribe' | 'speakers' | null;

export interface ChoiceChange {
  readonly choices: PlanChoices;
  readonly dropped: DroppedBy;
}

const NO_SUBJECTS = { subjects: false } as const;

/** Unticking "Transcrever" takes everything that reads the words with it. */
export function withTranscribe(
  choices: PlanChoices,
  transcribe: boolean,
): ChoiceChange {
  if (transcribe) return { choices: { ...choices, transcribe }, dropped: null };
  const lost = choices.speakers || choices.tracks !== 'none';
  return {
    choices: {
      ...choices,
      ...NO_SUBJECTS,
      transcribe,
      speakers: false,
      tracks: 'none',
    },
    dropped: lost ? 'transcribe' : null,
  };
}

/** The AI reads the voices: without them it cannot run (BR-1). */
export function withSpeakers(
  choices: PlanChoices,
  speakers: boolean,
): ChoiceChange {
  const lost = !speakers && choices.tracks === 'ai';
  return {
    choices: {
      ...choices,
      speakers,
      tracks: lost ? 'none' : choices.tracks,
      subjects: lost ? false : choices.subjects,
    },
    dropped: lost ? 'speakers' : null,
  };
}

export const withTracks = (
  choices: PlanChoices,
  tracks: TrackChoice,
): PlanChoices => ({
  ...choices,
  tracks,
  subjects: tracks === 'none' ? false : choices.subjects,
});

/** The plan as sent: a paid option carries the value the person saw (BR-4). */
export const planOf = (
  choices: PlanChoices,
  estimateUsd: number | null,
): PreparationPlanRequest => ({
  ...choices,
  acceptedUsd: choices.tracks === 'ai' ? estimateUsd : null,
});

/**
 * One file's part of a plan sent for several: the value the person saw is for them all, and
 * each file may only spend its share of it, by length (BR-4). Rounded down to the
 * micro-dollar, so the files together never pass what was shown (KBC-112 QA-3);
 * `toPrecision` keeps a share that is exact (0.02) from losing a micro-dollar to the float.
 */
export function planShare(
  plan: PreparationPlanRequest,
  { lengthMs, allMs }: { readonly lengthMs: number; readonly allMs: number },
): PreparationPlanRequest {
  const { acceptedUsd } = plan;
  if (acceptedUsd === null || acceptedUsd === undefined) return plan;
  if (lengthMs === allMs) return plan;
  const share = (acceptedUsd * lengthMs) / allMs;
  const micro = Math.floor(Number((share * 1e6).toPrecision(12)));
  return { ...plan, acceptedUsd: micro / 1e6 };
}

/** The same choices, whatever the estimate of the moment says. */
export const sameChoices = (
  a: PreparationPlanRequest,
  b: PreparationPlanRequest,
): boolean =>
  a.transcribe === b.transcribe &&
  a.speakers === b.speakers &&
  a.tracks === b.tracks &&
  a.subjects === b.subjects;

/** Goes through the guided flow; only transcribing ends at the upload (AC-15). */
export const isGuided = (choices: PlanChoices): boolean =>
  choices.speakers || choices.tracks !== 'none';

/** BR-2: the next upload starts from this one, except what costs money. */
export function rememberChoices(choices: PlanChoices): void {
  const free: PlanChoices = {
    ...choices,
    tracks: choices.tracks === 'ai' ? 'none' : choices.tracks,
    subjects: false,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(free));
  } catch {
    // A browser that keeps nothing just starts from the defaults.
  }
}

const isTrackChoice = (value: unknown): value is TrackChoice =>
  value === 'none' || value === 'manual' || value === 'ai';

/** The last choice, kept only as far as this person may still choose it. */
export function recalledChoices(canEdit: boolean): PlanChoices {
  const defaults = defaultChoices(canEdit);
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '');
    if (typeof saved !== 'object' || saved === null) return defaults;
    const { transcribe, speakers, tracks } = saved as Record<string, unknown>;
    if (typeof transcribe !== 'boolean' || typeof speakers !== 'boolean')
      return defaults;
    if (!canEdit) return { ...defaults, transcribe };
    const free = isTrackChoice(tracks) && tracks !== 'ai' ? tracks : 'none';
    return { transcribe, speakers, tracks: free, subjects: false };
  } catch {
    return defaults;
  }
}
