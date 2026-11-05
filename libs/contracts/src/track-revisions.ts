import { z } from 'zod';
import { editTrackSchema, trackProblemSchema } from './media-edit.js';
import { mediaIdSchema, updateMediaRequestSchema } from './media.js';
import { TRACK_TITLE_MAX, voiceSchema } from './track-proposals.js';
import { TRACK_SUMMARY_MAX } from './track-subjects.js';

/**
 * Changing a track after its approval (KBC-073, ADR 0029): the same id, a new cut from the
 * recording, an archive with a way back and a history. Everything a listener saved follows the
 * absolute time in the recording (BR-4).
 */

/** How long a deleted track can come back (owner's default 9). */
export const TRACK_RESTORE_DAYS = 30;
export const TRACK_RESTORE_MS = TRACK_RESTORE_DAYS * 24 * 60 * 60 * 1000;

/** Who a change of speaker reaches: this track, or the voice in the whole recording (FR-1). */
export const TRACK_SPEAKER_SCOPES = ['track', 'recording'] as const;
export const trackSpeakerScopeSchema = z.enum(TRACK_SPEAKER_SCOPES);
export type TrackSpeakerScope = z.infer<typeof trackSpeakerScopeSchema>;

/** What a person changes on a track; `PATCH /api/v1/media/{id}` with `If-Match`. */
export const trackPatchSchema = z.strictObject({
  title: z.string().trim().min(1).max(TRACK_TITLE_MAX).optional(),
  summary: z
    .string()
    .max(TRACK_SUMMARY_MAX)
    .nullable()
    .optional()
    .transform((summary) =>
      summary === undefined ? undefined : summary?.trim() || null,
    ),
  askerSpeakerId: z.uuid().nullable().optional(),
  answererSpeakerId: z.uuid().nullable().optional(),
  scope: trackSpeakerScopeSchema.optional(),
});
export type TrackPatch = z.output<typeof trackPatchSchema>;
export type TrackPatchRequest = z.input<typeof trackPatchSchema>;

/** The body of `PATCH /api/v1/media/{id}`, a recording's or a track's; the route tells them. */
export const updateMediaBodySchema = updateMediaRequestSchema.extend({
  summary: trackPatchSchema.shape.summary,
  askerSpeakerId: trackPatchSchema.shape.askerSpeakerId,
  answererSpeakerId: trackPatchSchema.shape.answererSpeakerId,
  scope: trackPatchSchema.shape.scope,
});

/** Who speaks in one role of a track: its own choice or else its voice's name. */
export const trackSpeakerSchema = z.object({
  voice: voiceSchema.nullable(),
  speakerId: z.uuid().nullable(),
  /** The name shown: blank when nobody named the voice. */
  name: z.string().nullable(),
});
export type TrackSpeaker = z.infer<typeof trackSpeakerSchema>;

/** Where a re-cut stands: `running` still serves the old file (BR-3). */
export const TRACK_CUT_STATES = ['none', 'running', 'failed'] as const;
export const trackCutStateSchema = z.enum(TRACK_CUT_STATES);
export type TrackCutState = z.infer<typeof trackCutStateSchema>;

/** A sibling of the track, by the bounds asked for it. */
export const trackNeighbourSchema = z.object({
  id: mediaIdSchema,
  ordinal: z.number().int().positive(),
  title: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
});
export type TrackNeighbour = z.infer<typeof trackNeighbourSchema>;

/** GET /api/v1/media/{id}/track-edit: what the edit dialog and the bounds editor need. */
export const trackEditViewSchema = z.object({
  mediaId: mediaIdSchema,
  recordingId: mediaIdSchema,
  recordingTitle: z.string(),
  topic: z.string(),
  /** `If-Match` of the next write. */
  version: z.number().int().nonnegative(),
  title: z.string(),
  summary: z.string().nullable(),
  ordinal: z.number().int().positive(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  recordingDurationMs: z.number().int().positive(),
  asker: trackSpeakerSchema,
  answerer: trackSpeakerSchema,
  cut: trackCutStateSchema,
  /** The recording's edit is open: its next approval decides. */
  locked: z.boolean(),
  /** Every track of the recording, this one included, in time order. */
  tracks: z.array(trackNeighbourSchema),
});
export type TrackEditView = z.infer<typeof trackEditViewSchema>;

/** PUT /api/v1/media/{id}/bounds, with `If-Match` (FR-2). */
export const trackBoundsRequestSchema = z.strictObject({
  startMs: editTrackSchema.shape.startMs,
  endMs: editTrackSchema.shape.endMs,
});
export type TrackBoundsRequest = z.infer<typeof trackBoundsRequestSchema>;

export const trackBoundsProblemsSchema = z.object({
  problems: z.array(trackProblemSchema),
});

/** GET /api/v1/media/{id}/track-impact: what a deletion touches, said first (FR-4). */
export const trackImpactSchema = z.object({
  /** People with a saved position in it. */
  listeners: z.number().int().nonnegative(),
  bookmarks: z.number().int().nonnegative(),
});
export type TrackImpact = z.infer<typeof trackImpactSchema>;

/** A track deleted from a recording (FR-3). */
export const archivedTrackSchema = z.object({
  mediaId: mediaIdSchema,
  title: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  archivedAt: z.iso.datetime(),
  restorableUntil: z.iso.datetime(),
  restorable: z.boolean(),
});
export type ArchivedTrack = z.infer<typeof archivedTrackSchema>;

export const archivedTracksSchema = z.object({
  tracks: z.array(archivedTrackSchema),
});
export type ArchivedTracks = z.infer<typeof archivedTracksSchema>;

/** What the history names (BR-8). */
export const TRACK_CHANGE_FIELDS = [
  'title',
  'summary',
  'asker',
  'answerer',
  'bounds',
  'subjects',
  'archived',
  'restored',
] as const;
export const trackChangeFieldSchema = z.enum(TRACK_CHANGE_FIELDS);
export type TrackChangeField = z.infer<typeof trackChangeFieldSchema>;

export const trackChangeSchema = z.object({
  id: z.uuid(),
  at: z.iso.datetime(),
  /** The person's name when it was made. */
  by: z.string(),
  field: trackChangeFieldSchema,
  /** `bounds` is `<startMs>-<endMs>`; the rest is what the person read. */
  before: z.string().nullable(),
  after: z.string().nullable(),
});
export type TrackChange = z.infer<typeof trackChangeSchema>;

/** GET /api/v1/media/{id}/history: newest first (FR-5). */
export const trackHistorySchema = z.object({
  changes: z.array(trackChangeSchema),
});
export type TrackHistory = z.infer<typeof trackHistorySchema>;

/** POST /api/v1/media/{id}/suggestions (FR-7): `dryRun` only estimates. */
export const trackSuggestionRequestSchema = z.strictObject({
  dryRun: z.boolean(),
});
export type TrackSuggestionRequest = z.infer<
  typeof trackSuggestionRequestSchema
>;

/** A subject the model proposed; `new` does not exist yet. */
export const suggestedSubjectSchema = z.object({
  kind: z.enum(['concept', 'free', 'new']),
  name: z.string(),
  /** The free subject's id; null otherwise. */
  id: z.uuid().nullable(),
});
export type SuggestedSubject = z.infer<typeof suggestedSubjectSchema>;

/** Nothing here is saved: each line waits for a person (BR-9). */
export const trackSuggestionSchema = z.object({
  title: z.string().nullable(),
  summary: z.string().nullable(),
  askerSpeakerId: z.uuid().nullable(),
  answererSpeakerId: z.uuid().nullable(),
  subjects: z.array(suggestedSubjectSchema),
  spentUsd: z.number().nonnegative(),
});
export type TrackSuggestion = z.infer<typeof trackSuggestionSchema>;

/** Bookmarks that left a track for the recording, not yet acknowledged (BR-4). */
export const movedBookmarksEntrySchema = z.object({
  /** The track they left. */
  mediaId: mediaIdSchema,
  /** The recording they went to. */
  recordingId: mediaIdSchema,
  title: z.string(),
  count: z.number().int().positive(),
});
export type MovedBookmarksEntry = z.infer<typeof movedBookmarksEntrySchema>;

export const movedBookmarksSchema = z.object({
  moved: z.array(movedBookmarksEntrySchema),
});
export type MovedBookmarks = z.infer<typeof movedBookmarksSchema>;

/** POST /api/v1/media/bookmarks/moved/seen: one track's notice, read by its owner. */
export const movedBookmarksSeenSchema = z.strictObject({
  mediaId: mediaIdSchema,
});

/** A track's file moved in its recording, and how long the new one is. */
export interface TrackMove {
  readonly oldStartMs: number;
  readonly newStartMs: number;
  readonly durationMs: number;
}

/** Where a saved position lands: `heard` when it fell past the new end (BR-4). */
export interface RemappedPosition {
  readonly positionMs: number;
  readonly heard: boolean;
}

/**
 * BR-4: through the absolute time. Before the new start it is 0, past the end it is heard;
 * 0 is "not started" and stays so.
 */
export function remapPosition(
  positionMs: number,
  move: TrackMove,
): RemappedPosition {
  if (positionMs === 0) return { positionMs: 0, heard: false };
  const next = positionMs + move.oldStartMs - move.newStartMs;
  if (next >= move.durationMs) return { positionMs: 0, heard: true };
  return { positionMs: Math.max(0, next), heard: false };
}

/** Where a bookmark lands: in the track, or at its moment in the full recording (BR-4). */
export type RemappedBookmark =
  | { readonly inTrack: true; readonly positionMs: number }
  | { readonly inTrack: false; readonly recordingMs: number };

export function remapBookmark(
  positionMs: number,
  move: TrackMove,
): RemappedBookmark {
  const absolute = move.oldStartMs + positionMs;
  const next = absolute - move.newStartMs;
  return next < 0 || next > move.durationMs
    ? { inTrack: false, recordingMs: absolute }
    : { inTrack: true, positionMs: next };
}
