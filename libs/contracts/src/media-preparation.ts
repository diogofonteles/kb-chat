import { z } from 'zod';
import {
  mediaIdSchema,
  preparationPlanSchema,
  transcriberPresenceSchema,
} from './media.js';
import {
  proposalFailureSchema,
  voiceSchema,
  voiceSuggestionSchema,
} from './track-proposals.js';

/**
 * The guided flow "Preparar áudio" (KBC-072, T20): the plan of a recording and where it is.
 * The state of each stage is read from the jobs and runs that do the work, never kept apart.
 */

/** The flow's four steps. */
export const preparationStepSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type PreparationStep = z.infer<typeof preparationStepSchema>;

export const PREPARATION_OPTIONS = [
  'transcribe',
  'speakers',
  'manual',
  'ai',
  'subjects',
] as const;
export const preparationOptionIdSchema = z.enum(PREPARATION_OPTIONS);
export type PreparationOptionId = z.infer<typeof preparationOptionIdSchema>;

/** Why an option cannot be chosen: said in words beside it (BR-3). */
export const OPTION_REFUSALS = [
  'permission',
  'dependency',
  'unavailable',
  'not-connected',
  'run-cap',
  'monthly-cap',
  'no-estimate',
  'approved',
] as const;
export const optionRefusalSchema = z.enum(OPTION_REFUSALS);
export type OptionRefusal = z.infer<typeof optionRefusalSchema>;

export const preparationOptionSchema = z.object({
  /** Already done on this recording: the option is left out (AC-16). */
  done: z.boolean(),
  refusal: optionRefusalSchema.nullable(),
  /** Machine time for the duration asked, in minutes; null without one. */
  minutes: z.number().nonnegative().nullable(),
});
export type PreparationOption = z.infer<typeof preparationOptionSchema>;

/** GET /api/v1/media/preparation-options: what the person may ask, with estimates (FR-7). */
export const preparationOptionsSchema = z.object({
  options: z.object({
    transcribe: preparationOptionSchema,
    speakers: preparationOptionSchema,
    manual: preparationOptionSchema,
    ai: preparationOptionSchema,
    subjects: preparationOptionSchema,
  }),
  /** The AI's estimate for the duration; null without one or without the permission. */
  aiEstimateUsd: z.number().nonnegative().nullable(),
  /** What is left of the media's month, only for who may spend it (AC-3). */
  monthRemainingUsd: z.number().nonnegative().nullable(),
  transcriber: transcriberPresenceSchema,
  transcriberOffSince: z.iso.datetime().nullable(),
});
export type PreparationOptions = z.infer<typeof preparationOptionsSchema>;

/** The longest length an estimate is asked for: past it, nothing is estimated. */
export const PREPARATION_MAX_DURATION_MS = 86_400_000;

export const preparationOptionsQuerySchema = z.object({
  topic: z.string().min(1).max(200).optional(),
  mediaId: mediaIdSchema.optional(),
  durationMs: z.coerce
    .number()
    .int()
    .positive()
    .max(PREPARATION_MAX_DURATION_MS)
    .optional(),
});
export type PreparationOptionsQuery = z.infer<
  typeof preparationOptionsQuerySchema
>;

/** `details` of a PLAN_REFUSED error: the reason per option (FR-1). */
export const planRefusalsSchema = z.object({
  options: z.array(
    z.object({
      option: preparationOptionIdSchema,
      refusal: optionRefusalSchema,
    }),
  ),
});
export type PlanRefusals = z.infer<typeof planRefusalsSchema>;

export const PREPARATION_STAGES = [
  'upload',
  'convert',
  'transcribe',
  'speakers',
  'tracks',
] as const;
export const preparationStageIdSchema = z.enum(PREPARATION_STAGES);
export type PreparationStageId = z.infer<typeof preparationStageIdSchema>;

export const STAGE_STATES = [
  'waiting',
  'queued',
  'running',
  'done',
  'failed',
  'blocked',
] as const;
export const stageStateSchema = z.enum(STAGE_STATES);
export type StageState = z.infer<typeof stageStateSchema>;

/** Why the paid stage did not run, on top of the reasons of a run that failed (KBC-067). */
export const STAGE_STOPS = [
  'run-cap',
  'monthly-cap',
  'no-permission',
  'not-connected',
  'provider-unavailable',
  'estimate-rose',
  'conflict',
] as const;
export const stageStopSchema = z.enum(STAGE_STOPS);
export type StageStop = z.infer<typeof stageStopSchema>;

export const stageFailureSchema = z.union([
  stageStopSchema,
  proposalFailureSchema,
  z.literal('work'),
]);
export type StageFailure = z.infer<typeof stageFailureSchema>;

const countSchema = z.number().int().nonnegative();

/** One stage of step 2; each field is null where it means nothing for that stage. */
export const preparationStageSchema = z.object({
  stage: preparationStageIdSchema,
  state: stageStateSchema,
  percent: z.number().int().min(0).max(100).nullable(),
  /** The cuts of a transcription; null for a transcriber too old to send them (FR-3). */
  cuts: z.object({ done: countSchema, total: countSchema }).nullable(),
  /** Jobs of the same kind before this one. */
  ahead: countSchema.nullable(),
  /** The stage that failed, when this one waits for it (BR-6). */
  blockedBy: preparationStageIdSchema.nullable(),
  failure: stageFailureSchema.nullable(),
  /** "Tentar de novo" is possible, for this person. */
  canRetry: z.boolean(),
  /** The windows of the AI's proposal. */
  windows: z.object({ done: countSchema, total: countSchema }).nullable(),
  reservedUsd: z.number().nonnegative().nullable(),
  spentUsd: z.number().nonnegative().nullable(),
  /** What a retry would cost: the new estimate when it rose. */
  estimateUsd: z.number().nonnegative().nullable(),
});
export type PreparationStage = z.infer<typeof preparationStageSchema>;

export const TRACK_ROW_STATUSES = [
  'proposed',
  'manual',
  'approved',
  'preparing',
] as const;
export const trackRowStatusSchema = z.enum(TRACK_ROW_STATUSES);
export type TrackRowStatus = z.infer<typeof trackRowStatusSchema>;

/** Who asks or answers on a track: a name, the audience, or only a voice. */
export const trackPersonSchema = z.object({
  name: z.string().min(1).nullable(),
  voice: voiceSchema.nullable(),
  audience: z.boolean(),
});
export type TrackPerson = z.infer<typeof trackPersonSchema>;

/** A track as it grows in step 2: heard here, corrected in step 3 (BR-7). */
export const preparationTrackSchema = z.object({
  id: z.uuid(),
  title: z.string().nullable(),
  startMs: countSchema,
  endMs: countSchema,
  asker: trackPersonSchema.nullable(),
  answerer: trackPersonSchema.nullable(),
  status: trackRowStatusSchema,
});
export type PreparationTrack = z.infer<typeof preparationTrackSchema>;

export const preparationVoiceSchema = z.object({
  voice: voiceSchema,
  speakingMs: countSchema,
  /** Who a person said it is; null until then. */
  name: z.string().min(1).nullable(),
  audience: z.boolean(),
});
export type PreparationVoice = z.infer<typeof preparationVoiceSchema>;

export const NEXT_ACTIONS = ['validate', 'conclude'] as const;
export const nextActionSchema = z.enum(NEXT_ACTIONS);
export type NextAction = z.infer<typeof nextActionSchema>;

/** GET /api/v1/media/:id/preparation (FR-2). */
export const mediaPreparationSchema = z.object({
  mediaId: mediaIdSchema,
  title: z.string().min(1),
  topic: z.string().min(1),
  /** The recording's author: the first name to suggest for a voice. */
  author: z.string().min(1).nullable(),
  step: preparationStepSchema,
  /** Step 3 was not asked for ("Não dividir agora"). */
  skipped: z.boolean(),
  finished: z.boolean(),
  /** Null before a person asked anything of this recording. */
  plan: preparationPlanSchema.nullable(),
  stages: z.array(preparationStageSchema),
  /** The separation these voices are from; naming a voice names it. */
  separation: z.number().int().min(1).nullable(),
  voices: z.array(preparationVoiceSchema),
  suggestions: z.array(voiceSuggestionSchema),
  tracks: z.array(preparationTrackSchema),
  /** The primary action once nothing is left to process; never taken by itself (FR-5). */
  next: nextActionSchema.nullable(),
  /** "Marcar as faixas eu mesmo" is open (BR-6). */
  canSwitchToManual: z.boolean(),
  transcriber: transcriberPresenceSchema,
  transcriberOffSince: z.iso.datetime().nullable(),
});
export type MediaPreparation = z.infer<typeof mediaPreparationSchema>;

/** POST /api/v1/media/:id/preparation: the plan of an audio already sent (AC-16). */
export const startPreparationRequestSchema = z.strictObject({
  plan: preparationPlanSchema,
});
export type StartPreparationRequest = z.input<
  typeof startPreparationRequestSchema
>;

/** PATCH …/preparation: from the AI to marking by hand (FR-4). */
export const changePreparationRequestSchema = z.strictObject({
  tracks: z.literal('manual'),
});
export type ChangePreparationRequest = z.infer<
  typeof changePreparationRequestSchema
>;

/** The stages "Tentar de novo" can redo. */
export const retryStageSchema = z.enum([
  'convert',
  'transcribe',
  'speakers',
  'tracks',
]);
export type RetryStage = z.infer<typeof retryStageSchema>;

/** GET /api/v1/media/preparations: where each open preparation stopped (FR-6). */
export const openPreparationsSchema = z.object({
  items: z.array(
    z.object({ mediaId: mediaIdSchema, step: preparationStepSchema }),
  ),
});
export type OpenPreparations = z.infer<typeof openPreparationsSchema>;
