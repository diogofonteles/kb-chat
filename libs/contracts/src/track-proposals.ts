import { z } from 'zod';

/**
 * Tracks proposed by the AI (KBC-067, ADR 0029 §4 and §7): the app's AI reads the transcript
 * (text only, never audio) and writes draft tracks a person reviews before anything is
 * applied (KBC-066). Each run is estimated first and reserved against the media monthly
 * budget (ADR 0022 §7), with a cap per run.
 */

/** A track is a question with its whole answer (`qa`) or a talk without a question. */
export const TRACK_KINDS = ['qa', 'talk'] as const;
export const trackKindSchema = z.enum(TRACK_KINDS);
export type TrackKind = z.infer<typeof trackKindSchema>;

/** Longest proposed title kept (KBC-067 BR-4); a longer one is dropped for the person to write. */
export const PROPOSED_TITLE_MAX = 80;

/** Longest title a person may give a track (KBC-066 BR-5). */
export const TRACK_TITLE_MAX = 120;

/** Shortest track (ADR 0029 §4, KBC-066 BR-4). */
export const MIN_TRACK_MS = 5_000;

/** A voice of the recording's separation (KBC-064): 1 to 10, meaningless outside it. */
export const voiceSchema = z.number().int().min(1).max(10);

/** Where a draft track came from: the AI's proposal or a person (KBC-066). */
export const draftTrackSourceSchema = z.enum(['ai', 'manual']);

/** A track in the draft, invisible to listeners until a person approves (BR-1). */
export const draftTrackSchema = z.object({
  id: z.uuid(),
  /** The proposal run that wrote it; null for a person's track. */
  runId: z.uuid().nullable(),
  source: draftTrackSourceSchema,
  /** A person moved or renamed it: a new run leaves it alone (BR-6). */
  edited: z.boolean(),
  /** First and last segment (1-based, of the transcript the run read); null for a person's. */
  firstSegment: z.number().int().min(1).nullable(),
  lastSegment: z.number().int().min(1).nullable(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  kind: trackKindSchema,
  /** Null when the AI's title was refused (BR-4): the person writes one. */
  title: z.string().min(1).max(TRACK_TITLE_MAX).nullable(),
  askerVoice: voiceSchema.nullable(),
  answererVoice: voiceSchema.nullable(),
  /** The speaker a person chose (KBC-066); wins over the voice's name. */
  askerSpeakerId: z.uuid().nullable(),
  answererSpeakerId: z.uuid().nullable(),
});
export type DraftTrack = z.infer<typeof draftTrackSchema>;

/** A name suggested for a voice from context, never from the voice itself (BR-5). */
export const voiceSuggestionSchema = z.object({
  voice: voiceSchema,
  /** Null for an audience question or when no name could be justified. */
  name: z.string().min(1).max(80).nullable(),
  audience: z.boolean(),
  reason: z.string().min(1).max(300),
});
export type VoiceSuggestion = z.infer<typeof voiceSuggestionSchema>;

export const PROPOSAL_STATUSES = ['running', 'done', 'failed'] as const;
export const proposalStatusSchema = z.enum(PROPOSAL_STATUSES);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

/** Why a run ended as "Não foi possível propor" (FR-5). */
export const PROPOSAL_FAILURES = [
  'provider',
  'invalid-output',
  'run-cap',
  'interrupted',
] as const;
export const proposalFailureSchema = z.enum(PROPOSAL_FAILURES);
export type ProposalFailure = z.infer<typeof proposalFailureSchema>;

/** One proposal run: its progress per window, so the list can grow while it runs (KBC-072). */
export const proposalRunSchema = z.object({
  id: z.uuid(),
  mediaId: z.uuid(),
  status: proposalStatusSchema,
  model: z.string(),
  windowsTotal: z.number().int().positive(),
  windowsDone: z.number().int().nonnegative(),
  /** Tracks this run has written so far. */
  tracks: z.number().int().nonnegative(),
  estimateUsd: z.number().nonnegative(),
  /** What the run really cost so far ("Custou US$ 0,02", FR-4). */
  spentUsd: z.number().nonnegative(),
  failure: proposalFailureSchema.nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type ProposalRun = z.infer<typeof proposalRunSchema>;

/** POST /api/v1/media/{id}/edit/proposals: `dryRun` only estimates (FR-1). */
export const proposalRequestSchema = z.strictObject({
  dryRun: z.boolean().default(false),
});
export type ProposalRequest = z.infer<typeof proposalRequestSchema>;

/** Which cap would be crossed (BR-3). */
export const spendCapSchema = z.enum(['run-cap', 'monthly-cap']);
export type SpendCap = z.infer<typeof spendCapSchema>;

/** The estimate shown before running (BR-3); the month's balance only for masters (FR-4). */
export const proposalEstimateSchema = z.object({
  estimateUsd: z.number().nonnegative(),
  runCapUsd: z.number().nonnegative(),
  windows: z.number().int().positive(),
  model: z.string(),
  allowed: z.boolean(),
  refusal: spendCapSchema.nullable(),
  month: z
    .object({
      spentUsd: z.number().nonnegative(),
      capUsd: z.number().nonnegative(),
    })
    .nullable(),
});
export type ProposalEstimate = z.infer<typeof proposalEstimateSchema>;

/** GET /api/v1/media/{id}/edit/draft-tracks: the draft as it is now. */
export const draftTracksSchema = z.object({
  /** The run whose proposals are shown (the newest that did not fail); null before one. */
  run: proposalRunSchema.nullable(),
  /** Why the newest run failed; null once a later one runs or ends well (FR-5). */
  lastFailure: proposalFailureSchema.nullable(),
  tracks: z.array(draftTrackSchema),
  voices: z.array(voiceSuggestionSchema),
});
export type DraftTracks = z.infer<typeof draftTracksSchema>;
