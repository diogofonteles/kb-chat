import { z } from 'zod';
import { rawChunkResultSchema, rawTranscriptSchema } from './media.js';

/* ---------- Groq as the transcription fallback (KBC-037, ADR 0023 §7) ---------- */

/**
 * When Groq may transcribe: never (the default, BR-1), only when a master asks, or when the
 * Mac has not been seen for `idleHours` and a job waited that long (FR-2).
 */
export const GROQ_MODES = ['never', 'manual', 'idle'] as const;
export const groqModeSchema = z.enum(GROQ_MODES);
export type GroqMode = z.infer<typeof groqModeSchema>;

export const GROQ_IDLE_HOURS = { min: 1, max: 168, default: 12 } as const;
export const groqIdleHoursSchema = z
  .number()
  .int()
  .min(GROQ_IDLE_HOURS.min)
  .max(GROQ_IDLE_HOURS.max);

/** The model and the price of a request (US$ 0.04 per hour, 10 s minimum, BR-2). */
export const GROQ_MODEL = 'whisper-large-v3-turbo';
export const GROQ_USD_PER_HOUR = 0.04;
export const GROQ_MIN_BILLED_MS = 10_000;

/** The free tier's limits (FR-3), honoured by the API's pacer. */
export const GROQ_FREE_TIER = {
  requestsPerMinute: 20,
  audioSecondsPerHour: 7_200,
  audioSecondsPerDay: 28_800,
} as const;

/** The largest chunk the worker sends (whisper's window is 30 s, ADR 0023 §3). */
export const GROQ_CHUNK_MAX_MS = 28_000;
/**
 * How the VM worker finds speech for Groq (ffmpeg `silencedetect`, the Mac's Silero values
 * where they map): pauses of 1 s under -35 dB split it, each span padded by 300 ms, spans
 * under 250 ms dropped; under 40 % of speech the track goes in fixed 28 s windows.
 */
export const GROQ_VAD = {
  engine: 'ffmpeg silencedetect',
  noiseDb: -35,
  minSilenceMs: 1_000,
  padMs: 300,
  minSpeechMs: 250,
  minSpeechRatio: 0.4,
} as const;
/** Bump with any change to the request or the VAD: stored with every Groq transcript. */
export const GROQ_PARAMETERS_VERSION = '2026-11-05.1';

/** One chunk's FLAC, with room to spare (28 s of 16 kHz mono FLAC is under 1 MB). */
export const MAX_GROQ_CHUNK_BYTES = 4 * 1024 * 1024;

/** The media monthly spend: what a master sees (FR-5). */
export const mediaMonthSchema = z.object({
  spentUsd: z.number().min(0),
  capUsd: z.number().min(0),
});
export type MediaMonth = z.infer<typeof mediaMonthSchema>;

/** GET /api/v1/media/groq (masters): never the key itself (BR-3). */
export const groqSettingsSchema = z.object({
  connected: z.boolean(),
  mode: groqModeSchema,
  idleHours: groqIdleHoursSchema,
  month: mediaMonthSchema,
  /** Only the owner edits the monthly cap (BR-2). */
  canEditCap: z.boolean(),
});
export type GroqSettings = z.infer<typeof groqSettingsSchema>;

/** POST /api/v1/media/groq/test: a key pasted now, or the stored one when absent. */
export const groqTestRequestSchema = z.strictObject({
  key: z.string().trim().min(1).max(500).optional(),
});
export type GroqTestRequest = z.infer<typeof groqTestRequestSchema>;

export const GROQ_TEST_FAILURES = [
  'key-rejected',
  'unreachable',
  'no-key',
] as const;
export const groqTestFailureSchema = z.enum(GROQ_TEST_FAILURES);
export type GroqTestFailure = z.infer<typeof groqTestFailureSchema>;

/** "Conectado", or why not (FR-1). A key pasted is kept only when Groq accepted it. */
export const groqTestResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), settings: groqSettingsSchema }),
  z.object({ ok: z.literal(false), reason: groqTestFailureSchema }),
]);
export type GroqTestResult = z.infer<typeof groqTestResultSchema>;

/** PUT /api/v1/media/groq/mode. */
export const groqModeRequestSchema = z.strictObject({
  mode: groqModeSchema,
  idleHours: groqIdleHoursSchema,
});
export type GroqModeRequest = z.infer<typeof groqModeRequestSchema>;

/** PUT /api/v1/media/spend-cap (the owner only, BR-2). */
export const mediaSpendCapRequestSchema = z.strictObject({
  capUsd: z.number().min(0).max(1_000),
});
export type MediaSpendCapRequest = z.infer<typeof mediaSpendCapRequestSchema>;

/** POST /api/v1/media-worker/jobs/:id/groq/chunks: where the chunk sits in the track. */
export const groqChunkQuerySchema = z.object({
  leaseId: z.uuid(),
  worker: z.string().min(1).max(100),
  startMs: z.coerce
    .number()
    .int()
    .min(0)
    .max(100 * 3_600_000),
  endMs: z.coerce
    .number()
    .int()
    .min(1)
    .max(100 * 3_600_000),
  /** The job's term list version (the lease named it). */
  termsVersion: z.coerce.number().int().min(1).max(1_000_000),
});
export type GroqChunkQuery = z.infer<typeof groqChunkQuerySchema>;

/** Groq's answer for one chunk, its words placed in their segments (the Mac's shape). */
export const groqChunkResultSchema = z.object({ result: rawChunkResultSchema });
export type GroqChunkResult = z.infer<typeof groqChunkResultSchema>;

/** POST /api/v1/media-worker/jobs/:id/groq/transcript: the chunks put together. */
export const completeGroqTranscriptRequestSchema = z.strictObject({
  worker: z.string().min(1).max(100),
  leaseId: z.uuid(),
  termsVersion: z.number().int().min(1),
  vad: z.enum(['applied', 'skipped']),
  speechRatio: z.number().min(0).max(1),
  elapsedMs: z.number().int().min(0),
  raw: rawTranscriptSchema,
});
export type CompleteGroqTranscriptRequest = z.infer<
  typeof completeGroqTranscriptRequestSchema
>;
