import { z } from 'zod';
import { topicSlugSchema } from './topics.js';

/**
 * The media library (phase 2, ADR 0022): audio uploaded to a collection, converted by the
 * media worker and streamed to the player (ADR 0025).
 */

/** The largest single upload of the walking skeleton (KBC-034 FR-2): 500 MB. */
export const MEDIA_MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

/** Audio formats accepted for upload, by extension and the MIME types browsers send. */
export const MEDIA_UPLOAD_EXTENSIONS = [
  'mp3',
  'm4a',
  'wav',
  'flac',
  'ogg',
  'opus',
] as const;
export const MEDIA_UPLOAD_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/flac',
  'audio/x-flac',
  'audio/ogg',
  'audio/opus',
  'application/octet-stream',
] as const;

/** Media has the two authorships an uploader can tell apart (ADR 0015). */
export const MEDIA_AUTHORSHIPS = ['mestre-laercio', 'outros-autores'] as const;
export const mediaAuthorshipSchema = z.enum(MEDIA_AUTHORSHIPS);
export type MediaAuthorship = z.infer<typeof mediaAuthorshipSchema>;

export const mediaIdSchema = z.uuid();

/** Where a media item is: sent, waiting, being converted, playable or failed. */
export const MEDIA_STATUSES = [
  'uploading',
  'queued',
  'processing',
  'ready',
  'failed',
] as const;
export const mediaStatusSchema = z.enum(MEDIA_STATUSES);
export type MediaStatus = z.infer<typeof mediaStatusSchema>;

/**
 * Why a media item failed: not an audio file (permanent), the conversion crashed (a retry
 * may help), the worker stopped too many times (KBC-034 BR-5), or the upload never ended.
 */
export const MEDIA_FAILURES = [
  'invalid-audio',
  'conversion-failed',
  'too-many-attempts',
  'upload-abandoned',
] as const;
export const mediaFailureSchema = z.enum(MEDIA_FAILURES);
export type MediaFailure = z.infer<typeof mediaFailureSchema>;

export const mediaItemSchema = z.object({
  id: mediaIdSchema,
  topic: topicSlugSchema,
  title: z.string().min(1).max(200),
  authorship: mediaAuthorshipSchema,
  status: mediaStatusSchema,
  /** Conversion progress (0–100) while processing; null otherwise. */
  progress: z.number().int().min(0).max(100).nullable(),
  failure: mediaFailureSchema.nullable(),
  /** Known once converted. */
  durationMs: z.number().int().min(0).nullable(),
  /** Size of the converted file. */
  bytes: z.number().int().min(0).nullable(),
  createdAt: z.iso.datetime(),
  /** A master may queue the conversion again (a failure that is not permanent). */
  canRetry: z.boolean(),
  /** Where the person who asks stopped (KBC-041 FR-2): 0 when never heard or heard to the end. */
  positionMs: z.number().int().min(0),
  /** When that person heard it to 95% or more (BR-2); null otherwise. */
  completedAt: z.iso.datetime().nullable(),
});
export type MediaItem = z.infer<typeof mediaItemSchema>;

export const mediaListSchema = z.object({ items: z.array(mediaItemSchema) });
export type MediaList = z.infer<typeof mediaListSchema>;

/** POST /api/v1/topics/:topic/media: the metadata; the file follows with PUT …/file. */
export const createMediaRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  authorship: mediaAuthorshipSchema,
  fileName: z.string().min(1).max(255),
  bytes: z.number().int().min(1).max(MEDIA_MAX_UPLOAD_BYTES),
});
export type CreateMediaRequest = z.infer<typeof createMediaRequestSchema>;

/* ---------- Listening: speed, display and position, per person (KBC-041) ---------- */

/** The playback speeds of the player's menu (screens.md T15). */
export const MEDIA_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export type MediaSpeed = (typeof MEDIA_SPEEDS)[number];

/** From this share of its length a media counts as heard and its position resets (BR-2). */
export const MEDIA_COMPLETION_RATIO = 0.95;

/** GET/PUT /api/v1/media/preferences: one person's choices, for every media and device. */
export const mediaPreferencesSchema = z.strictObject({
  speed: z.literal(MEDIA_SPEEDS),
  /** Remaining time (true) or total length (false) on the right of the time slider. */
  showRemaining: z.boolean(),
});
export type MediaPreferences = z.infer<typeof mediaPreferencesSchema>;

/** PUT /api/v1/media/:id/progress: where the person is, in ms. */
export const mediaProgressRequestSchema = z.strictObject({
  positionMs: z.number().int().min(0),
});
export type MediaProgressRequest = z.infer<typeof mediaProgressRequestSchema>;

/** True when a file name ends with an accepted audio extension. */
export function hasAcceptedAudioExtension(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return false;
  const extension = fileName.slice(dot + 1).toLowerCase();
  return (MEDIA_UPLOAD_EXTENSIONS as readonly string[]).includes(extension);
}

/* ---------- The media worker protocol (ADR 0022 §3) ---------- */

export const MEDIA_JOB_KINDS = ['transcode'] as const;
export const mediaJobKindSchema = z.enum(MEDIA_JOB_KINDS);
export type MediaJobKind = z.infer<typeof mediaJobKindSchema>;

export const mediaJobIdSchema = z.uuid();

export const leaseRequestSchema = z.strictObject({
  worker: z.string().min(1).max(100),
  kinds: z.array(mediaJobKindSchema).min(1),
});
export type LeaseRequest = z.infer<typeof leaseRequestSchema>;

/**
 * A leased job: the paths are relative to the shared media directory. `leaseId` names this
 * lease: a worker whose lease expired (the job went back to the queue) can no longer touch it.
 */
export const workerJobSchema = z.object({
  id: mediaJobIdSchema,
  leaseId: z.uuid(),
  kind: mediaJobKindSchema,
  mediaId: mediaIdSchema,
  attempt: z.number().int().min(1),
  sourcePath: z.string().min(1),
  targetPath: z.string().min(1),
  leaseMs: z.number().int().min(1),
});
export type WorkerJob = z.infer<typeof workerJobSchema>;

const leaseOwnerSchema = z.strictObject({
  worker: z.string().min(1).max(100),
  leaseId: z.uuid(),
});

export const heartbeatRequestSchema = leaseOwnerSchema.extend({
  progress: z.number().int().min(0).max(100).nullable(),
});
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

export const completeTranscodeRequestSchema = leaseOwnerSchema.extend({
  durationMs: z.number().int().min(0),
  bytes: z.number().int().min(1),
});
export type CompleteTranscodeRequest = z.infer<
  typeof completeTranscodeRequestSchema
>;

export const failJobRequestSchema = leaseOwnerSchema.extend({
  /** `invalid-audio` is permanent and never retried (KBC-034 BR-5). */
  failure: z.enum(['invalid-audio', 'conversion-failed']),
  /** For the log; never shown to people. */
  detail: z.string().max(2_000),
});
export type FailJobRequest = z.infer<typeof failJobRequestSchema>;
