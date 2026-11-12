import type {
  HiddenSpan,
  LevelChoice,
  TrackLevelChoices,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type {
  LiveTrackLevel,
  MediaStorePort,
} from '../../ports/media-store.js';
import { hearsLevel } from './media-policy.js';
import type { MediaActor } from './media-service.js';

/**
 * A track's own level (KBC-106, ADR 0036 §3): the recording's until someone chooses one above
 * it, never below (the passage is in the whole recording, BR-1), never above the person's own.
 */
export interface TrackLevelContext {
  /** The recording's collection scale, lowest first; empty: no levels. */
  readonly scale: readonly LevelChoice[];
  /** The recording's level; null: none ("Sem nível"). */
  readonly recording: string | null;
  /** The levels the person sees there; null: every level (a master). */
  readonly allowed: readonly string[] | null;
}

const rankIn = (scale: readonly LevelChoice[], id: string | null): number =>
  id === null ? -1 : scale.findIndex((one) => one.id === id);

/** What the "Nível" of a track offers: above the recording, up to the person's own. */
export function trackLevelChoices(
  context: TrackLevelContext,
): TrackLevelChoices {
  const { scale, recording, allowed } = context;
  const own = scale.find((one) => one.id === recording);
  if (scale.length === 0 || !own) return null;
  const from = rankIn(scale, recording);
  return {
    recording: { id: own.id, code: own.code },
    choices: scale
      .filter((one, index) => index > from)
      .filter((one) => allowed === null || allowed.includes(one.id))
      .map(({ id, code }) => ({ id, code })),
  };
}

const field = { details: { field: 'level' } };

/**
 * FR-1: the own level a request asks for, checked; null when the track follows its
 * recording (asked null, or the recording's own level).
 */
export function ownLevelOf(
  context: TrackLevelContext,
  asked: string | null,
): string | null {
  if (asked === null) return null;
  const { scale, recording, allowed } = context;
  const rank = rankIn(scale, asked);
  if (rank < 0) throw new AppError('VALIDATION_FAILED', 'Unknown level', field);
  if (rank < rankIn(scale, recording))
    throw new AppError(
      'LEVEL_BELOW_RECORDING',
      "A track's level cannot be below its recording's",
      field,
    );
  if (allowed !== null && !allowed.includes(asked))
    throw new AppError('LEVEL_ABOVE_YOURS', 'This level is above yours', field);
  return asked === recording ? null : asked;
}

/**
 * The own level an approval gives a track (KBC-106): the draft's, unless it no longer is above
 * the recording (raised since) or no longer in the scale; then it follows the recording.
 */
export function approvedLevelOf(
  context: Pick<TrackLevelContext, 'scale' | 'recording'>,
  drafted: string | null,
): string | null {
  const rank = rankIn(context.scale, drafted);
  return rank > rankIn(context.scale, context.recording) ? drafted : null;
}

/** The levels of the scale under `level`, which a recording raised to it lifts (BR-1). */
export function levelsBelow(
  scale: readonly LevelChoice[],
  level: string | null,
): string[] {
  const rank = rankIn(scale, level);
  return scale.slice(0, Math.max(0, rank)).map((one) => one.id);
}

/**
 * FR-2: the parts of a recording this person may not hear: its live tracks at a level they do
 * not see, merged where they touch. Empty for whoever sees every level.
 */
export function hiddenSpansOf(
  tracks: readonly LiveTrackLevel[],
  sees: (level: string | null) => boolean,
): HiddenSpan[] {
  const spans: HiddenSpan[] = [];
  const hidden = tracks
    .filter((track) => !sees(track.level) && track.endMs > track.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  for (const { startMs, endMs } of hidden) {
    const last = spans.at(-1);
    if (last && startMs <= last.endMs)
      spans[spans.length - 1] = {
        startMs: last.startMs,
        endMs: Math.max(last.endMs, endMs),
      };
    else spans.push({ startMs, endMs });
  }
  return spans;
}

/** A stretch `[startMs, endMs]` touches a hidden span (fail-closed: any overlap). */
export const touchesHidden = (
  spans: readonly HiddenSpan[],
  stretch: { readonly startMs: number; readonly endMs: number },
): boolean =>
  spans.some(
    (span) => stretch.startMs < span.endMs && stretch.endMs > span.startMs,
  );

/**
 * KBC-106 decision (2026-11-12): whether this person hears every level the recording's tracks
 * hold or are drafted at; who does not may not use its edit routes.
 */
export function hearsAllTracks(
  store: Pick<MediaStorePort, 'getMedia' | 'trackLevelsUnder'>,
  actor: MediaActor,
  recordingId: string,
): boolean {
  const recording = store.getMedia(recordingId);
  if (!recording || actor.levelsIn(recording.topic) === null) return true;
  return store
    .trackLevelsUnder(recordingId)
    .every((level) => hearsLevel(actor, recording.topic, level));
}

/** The refusal of an edit route to who is below a track of the recording. */
export const editAboveYourLevel = (): AppError =>
  new AppError(
    'EDIT_ABOVE_YOUR_LEVEL',
    'A track of this recording is above your level',
  );
