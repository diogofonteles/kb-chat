import { z } from 'zod';
import { voiceIndexSchema } from './voice-index.js';

/**
 * What a voice comparison leaves behind (KBC-071, ADR 0032). The prints themselves travel only
 * in the worker contracts below; `voiceProfileSuggestionSchema` is the one thing a browser reads.
 */

/**
 * The threshold of KBC-063: under it, no suggestion (BR-3). A starting value, not a calibrated
 * one: 2 speakers and 3 decisions (docs/research/2026-11-03-audio-editing-test-speakers.md).
 */
export const VOICE_MATCH_THRESHOLD = 0.4;
/** From here a suggestion reads "semelhança alta": same-person scores were 0.48 to 0.58. */
const HIGH_SIMILARITY = 0.5;

/** Said in words, never as a number: the scale is not calibrated (BR-3). */
export const VOICE_SIMILARITY_LEVELS = ['medium', 'high'] as const;
export type VoiceSimilarityLevel = (typeof VOICE_SIMILARITY_LEVELS)[number];

export const similarityLevelOf = (similarity: number): VoiceSimilarityLevel =>
  similarity >= HIGH_SIMILARITY ? 'high' : 'medium';

/** "Voz 1 parece ser Mestre Gabriel (semelhança alta)": for `media-edit` (FR-3). */
export const voiceProfileSuggestionSchema = z.object({
  voice: voiceIndexSchema,
  speakerId: z.uuid(),
  name: z.string().min(1),
  level: z.enum(VOICE_SIMILARITY_LEVELS),
});
export type VoiceProfileSuggestion = z.infer<
  typeof voiceProfileSuggestionSchema
>;

/* ---------- Between the API and a transcriber marked for voice profiles ---------- */

const MIN_PRINT_SIZE = 64;
const MAX_PRINT_SIZE = 1024;

/** A voice print: only in the worker contracts below (BR-5). */
export const voicePrintSchema = z
  .array(z.number().min(-1).max(1))
  .min(MIN_PRINT_SIZE)
  .max(MAX_PRINT_SIZE);

/** A voice's turns in one recording, for the Mac to calculate the print on. */
export const voiceProfileSourceJobSchema = z.object({
  /** GET it (with `?leaseId=`) for this recording's audio. */
  audioPath: z.string().min(1),
  spans: z.array(
    z.object({
      startMs: z.number().int().min(0),
      endMs: z.number().int().min(0),
    }),
  ),
});

/** A leased `voice-profile` job (FR-2). */
export const voiceProfileJobSchema = z.object({
  id: z.uuid(),
  leaseId: z.uuid(),
  kind: z.literal('voice-profile'),
  mediaId: z.uuid(),
  attempt: z.number().int().min(1),
  leaseMs: z.number().int().min(1),
  sources: z.array(voiceProfileSourceJobSchema).min(1),
});
export type VoiceProfileJob = z.infer<typeof voiceProfileJobSchema>;

/** POST /api/v1/media-worker/jobs/:id/voice-print. */
export const completeVoicePrintRequestSchema = z.strictObject({
  worker: z.string().min(1).max(100),
  leaseId: z.uuid(),
  model: z.string().min(1).max(200),
  embedding: voicePrintSchema,
});
export type CompleteVoicePrintRequest = z.infer<
  typeof completeVoicePrintRequestSchema
>;

/** GET …/jobs/:id/voice-profiles: the prints of the job's collection, during the job (BR-5). */
export const workerVoiceProfilesSchema = z.object({
  profiles: z.array(
    z.object({
      id: z.uuid(),
      model: z.string().min(1),
      embedding: voicePrintSchema,
    }),
  ),
});
export type WorkerVoiceProfiles = z.infer<typeof workerVoiceProfilesSchema>;

/** The closest profile of one voice, and how close: nothing else leaves the Mac (FR-3). */
export const voiceMatchSchema = z.strictObject({
  /** The worker's name for the voice, as in its turns. */
  voice: z.string().min(1).max(40),
  profileId: z.uuid(),
  similarity: z.number().min(-1).max(1),
});
export type VoiceMatch = z.infer<typeof voiceMatchSchema>;
