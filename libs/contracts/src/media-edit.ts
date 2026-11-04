import { z } from 'zod';
import { mediaIdSchema } from './media.js';
import {
  MIN_TRACK_MS,
  TRACK_TITLE_MAX,
  draftTrackSchema,
  draftTrackSourceSchema,
  proposalFailureSchema,
  proposalRunSchema,
  trackKindSchema,
  voiceSchema,
  voiceSuggestionSchema,
} from './track-proposals.js';

/**
 * Validating tracks before applying them (KBC-066, ADR 0029 §4): the draft a person edits in
 * the guided flow "Preparar áudio", and the tracks approved from it, the only ones listeners
 * see (BR-1).
 */

/** The most tracks a draft holds (200 is the item's extreme case). */
export const MAX_DRAFT_TRACKS = 500;

/** A proposal ends where the words do, which may be a moment past the rendition's end. */
const END_SLACK_MS = 2_000;

/** The guided flow's steps this item owns; KBC-072 adds 1 and 2. */
export const editStepSchema = z.union([z.literal(3), z.literal(4)]);
export type EditStep = z.infer<typeof editStepSchema>;

export const EDIT_STATUSES = ['draft', 'approved'] as const;
export const editStatusSchema = z.enum(EDIT_STATUSES);
export type EditStatus = z.infer<typeof editStatusSchema>;

/** GET /api/v1/media/:id/edit, with the version again as the `ETag`. */
/** "Preparando faixas: 3 de 12": listeners get them only when every one is done (FR-1). */
export const trackPreparationSchema = z.object({
  total: z.number().int().min(1),
  done: z.number().int().min(0),
  failed: z.number().int().min(0),
});
export type TrackPreparation = z.infer<typeof trackPreparationSchema>;

export const mediaEditSchema = z.object({
  mediaId: mediaIdSchema,
  /** 0 before the first save: `If-Match: "0"` starts the edit. */
  version: z.number().int().nonnegative(),
  /** False until someone saved or a proposal ran: "Dividir em faixas" on the audio's page. */
  started: z.boolean(),
  status: editStatusSchema,
  step: editStepSchema,
  tracks: z.array(draftTrackSchema),
  /** The newest proposal run that did not fail (KBC-067). */
  run: proposalRunSchema.nullable(),
  /** Why the newest run failed: it stays said until a later run (KBC-067 FR-5). */
  lastFailure: proposalFailureSchema.nullable(),
  voices: z.array(voiceSuggestionSchema),
  /** How many tracks listeners see now. */
  approvedTracks: z.number().int().nonnegative(),
  /** The transcript has a new version since this edit began (BR-10). */
  transcriptChanged: z.boolean(),
  /** The tracks being cut after an approval; null when nothing is on its way (KBC-068 FR-1). */
  preparation: trackPreparationSchema.nullable().default(null),
  /** The guided flow's open step for this recording (KBC-072 FR-6); none without a plan. */
  preparationStep: z
    .union([z.literal(2), z.literal(3)])
    .nullable()
    .optional(),
});
export type MediaEdit = z.infer<typeof mediaEditSchema>;

/** A track as the editor sends it; `edited` and the run are the server's to keep. */
export const editTrackSchema = z.strictObject({
  id: z.uuid(),
  source: draftTrackSourceSchema,
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  kind: trackKindSchema,
  /** Null or blank: allowed in a draft, refused on approval (BR-5). */
  title: z
    .string()
    .max(TRACK_TITLE_MAX)
    .nullable()
    .transform((title) => title?.trim() || null),
  askerVoice: voiceSchema.nullable(),
  answererVoice: voiceSchema.nullable(),
  askerSpeakerId: z.uuid().nullable(),
  answererSpeakerId: z.uuid().nullable(),
});
export type EditTrack = z.output<typeof editTrackSchema>;

/** PUT /api/v1/media/:id/edit, with `If-Match` (FR-1). An id appears once. */
export const saveEditRequestSchema = z.strictObject({
  tracks: z
    .array(editTrackSchema)
    .max(MAX_DRAFT_TRACKS)
    .refine(
      (tracks) => new Set(tracks.map(({ id }) => id)).size === tracks.length,
      { error: 'A track id appears twice' },
    ),
  step: editStepSchema,
});
export type SaveEditRequest = z.input<typeof saveEditRequestSchema>;

/** The new version after a save, an approval or a reopening. */
export const editSavedSchema = z.object({
  version: z.number().int().nonnegative(),
});
export type EditSaved = z.infer<typeof editSavedSchema>;

/** POST …/edit/approve: how many tracks listeners see now (FR-8). */
export const editApprovedSchema = editSavedSchema.extend({
  tracks: z.number().int().positive(),
});
export type EditApproved = z.infer<typeof editApprovedSchema>;

/** What is wrong with a track: `details.problems` of a TRACKS_INVALID error (FR-1, FR-8). */
export const TRACK_PROBLEMS = ['title', 'short', 'overlap', 'range'] as const;
export const trackProblemKindSchema = z.enum(TRACK_PROBLEMS);
export const trackProblemSchema = z.object({
  trackId: z.uuid(),
  /** 1-based, by start time, as the screen numbers it. */
  ordinal: z.number().int().positive(),
  problem: trackProblemKindSchema,
});
export type TrackProblem = z.infer<typeof trackProblemSchema>;
export const trackProblemsDetailsSchema = z.object({
  problems: z.array(trackProblemSchema),
});

/** The part of a track the rules read. */
export type TimedTrack = Pick<EditTrack, 'id' | 'startMs' | 'endMs'>;

function timingProblemsOf(
  track: TimedTrack,
  context: {
    readonly ordinal: number;
    readonly previousEndMs: number;
    readonly durationMs: number | null;
  },
): TrackProblem[] {
  const { ordinal, previousEndMs, durationMs } = context;
  const of = (problem: TrackProblem['problem']): TrackProblem => ({
    trackId: track.id,
    ordinal,
    problem,
  });
  const found: TrackProblem[] = [];
  if (track.endMs - track.startMs < MIN_TRACK_MS) found.push(of('short'));
  if (track.startMs < previousEndMs) found.push(of('overlap'));
  if (durationMs !== null && track.endMs > durationMs + END_SLACK_MS)
    found.push(of('range'));
  return found;
}

/** Tracks by start time, as they are numbered. */
export const inTimeOrder = <T extends Pick<TimedTrack, 'startMs'>>(
  tracks: readonly T[],
): T[] => [...tracks].sort((a, b) => a.startMs - b.startMs);

/** BR-3 and BR-4 over a whole draft: what a save refuses. Touching neighbours are fine. */
export function timingProblems(
  tracks: readonly TimedTrack[],
  durationMs: number | null,
): TrackProblem[] {
  let previousEndMs = 0;
  return inTimeOrder(tracks).flatMap((track, index) => {
    const context = { ordinal: index + 1, previousEndMs, durationMs };
    previousEndMs = Math.max(previousEndMs, track.endMs);
    return timingProblemsOf(track, context);
  });
}

/** What an approval refuses: the timing rules and an empty title (BR-5). */
export function approvalProblems(
  tracks: readonly (TimedTrack & { readonly title: string | null })[],
  durationMs: number | null,
): TrackProblem[] {
  const untitled = inTimeOrder(tracks).flatMap((track, index) =>
    track.title?.trim()
      ? []
      : [
          {
            trackId: track.id,
            ordinal: index + 1,
            problem: 'title' as const,
          },
        ],
  );
  return [...untitled, ...timingProblems(tracks, durationMs)].sort(
    (a, b) => a.ordinal - b.ordinal,
  );
}

/** A track as listeners get it (FR-2): chapters of the recording until KBC-068. */
export const approvedTrackSchema = z.object({
  id: z.uuid(),
  /** 1-based: `?track=` (FR-9). */
  ordinal: z.number().int().positive(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  kind: trackKindSchema,
  title: z.string().min(1).max(TRACK_TITLE_MAX),
});
export type ApprovedTrack = z.infer<typeof approvedTrackSchema>;

/** GET /api/v1/media/:id/tracks: approved tracks only, for `media-tracks`. */
export const mediaTracksSchema = z.object({
  tracks: z.array(approvedTrackSchema),
});
export type MediaTracks = z.infer<typeof mediaTracksSchema>;

/** One word's bounds and text, as a tuple: 2 h of speech is about 15,000 of them. */
export const editWordSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.string(),
]);
export type EditWord = z.infer<typeof editWordSchema>;

/** GET …/edit/words: the current transcript's words, where a handle snaps (BR-2). */
export const editWordsSchema = z.object({
  version: z.number().int().min(1),
  words: z.array(editWordSchema),
});
export type EditWords = z.infer<typeof editWordsSchema>;
