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

/* ---------- Transcription (KBC-036, ADR 0023) ---------- */

/** `low`: searchable and playable, always with the notice (BR-5). */
export const TRANSCRIPT_CONFIDENCES = ['normal', 'low'] as const;
export const transcriptConfidenceSchema = z.enum(TRANSCRIPT_CONFIDENCES);
export type TranscriptConfidence = z.infer<typeof transcriptConfidenceSchema>;

/**
 * Where a media item's transcription is: not asked yet (not converted), waiting for a
 * transcriber, being transcribed, done (the newest version is current) or given up.
 */
export const TRANSCRIPTION_STATUSES = [
  'none',
  'waiting',
  'transcribing',
  'done',
  'failed',
] as const;
export const transcriptionStatusSchema = z.enum(TRANSCRIPTION_STATUSES);
export type TranscriptionStatus = z.infer<typeof transcriptionStatusSchema>;

/** Whether a transcriber can pick the job up: seen in the last hour, not, or none paired. */
export const TRANSCRIBER_PRESENCES = ['on', 'off', 'none'] as const;
export const transcriberPresenceSchema = z.enum(TRANSCRIBER_PRESENCES);
export type TranscriberPresence = z.infer<typeof transcriberPresenceSchema>;

export const mediaTranscriptionSchema = z.object({
  status: transcriptionStatusSchema,
  /** The current version's; null before the first transcript. */
  confidence: transcriptConfidenceSchema.nullable(),
  /** The current version (1, 2, …); null before the first transcript. */
  version: z.number().int().min(1).nullable(),
  /** While waiting: is a transcriber on (FR-1)? */
  transcriber: transcriberPresenceSchema,
  /** With `off`: the last time one was seen (or paired, if never seen). */
  transcriberOffSince: z.iso.datetime().nullable(),
});
export type MediaTranscription = z.infer<typeof mediaTranscriptionSchema>;

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
  /**
   * When the server saved that person's position (its clock); null when never saved. A
   * browser's unsent copy is used only if no other device saved one since (FR-3).
   */
  positionUpdatedAt: z.iso.datetime().nullable(),
  /** Where its automatic transcription is (KBC-036). */
  transcription: mediaTranscriptionSchema,
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

/** How far "Voltar" and "Avançar" go, in seconds (KBC-043, screens.md T15 "Pulos"). */
export const MEDIA_SKIP_BACK_SECONDS = [5, 10, 15, 30] as const;
export const MEDIA_SKIP_FORWARD_SECONDS = [10, 15, 30, 45, 60] as const;

/** GET/PUT /api/v1/media/preferences: one person's choices, for every media and device. */
export const mediaPreferencesSchema = z.strictObject({
  speed: z.literal(MEDIA_SPEEDS),
  /** Remaining time (true) or total length (false) on the right of the time slider. */
  showRemaining: z.boolean(),
  skipBackSec: z.literal(MEDIA_SKIP_BACK_SECONDS),
  skipForwardSec: z.literal(MEDIA_SKIP_FORWARD_SECONDS),
});
export type MediaPreferences = z.infer<typeof mediaPreferencesSchema>;

/** PUT /api/v1/media/:id/progress: where the person is, in ms. */
export const mediaProgressRequestSchema = z.strictObject({
  positionMs: z.number().int().min(0),
  /**
   * The server's save this one continues (`positionUpdatedAt` as the client last saw it;
   * null when it saw none). A newer save from another device makes it a 409 (FR-3).
   */
  basedOn: z.iso.datetime().nullable(),
});
export type MediaProgressRequest = z.infer<typeof mediaProgressRequestSchema>;

/** The answer to PUT …/progress: what the server keeps now for that person. */
export const mediaProgressSchema = z.object({
  positionMs: z.number().int().min(0),
  completedAt: z.iso.datetime().nullable(),
  positionUpdatedAt: z.iso.datetime(),
});
export type MediaProgress = z.infer<typeof mediaProgressSchema>;

/* ---------- Bookmarks (KBC-042) ---------- */

/** The longest note of a bookmark. */
export const MEDIA_BOOKMARK_NOTE_MAX = 2_000;
/** The most bookmarks one person keeps in one media. */
export const MEDIA_BOOKMARKS_PER_MEDIA = 1_000;

export const mediaBookmarkIdSchema = z.uuid();
/** A note as kept: trimmed, at most 2 000 characters; blank means no note. */
const bookmarkNoteSchema = z
  .string()
  .trim()
  .max(MEDIA_BOOKMARK_NOTE_MAX)
  .nullable()
  .transform((note) => (note === '' ? null : note));

/** One person's mark in one media, with their note. */
export const mediaBookmarkSchema = z.object({
  id: mediaBookmarkIdSchema,
  mediaId: mediaIdSchema,
  positionMs: z.number().int().min(0),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type MediaBookmark = z.infer<typeof mediaBookmarkSchema>;

/** GET /api/v1/media/:id/bookmarks: the person's marks in that media, by position. */
export const mediaBookmarkListSchema = z.object({
  items: z.array(mediaBookmarkSchema),
});

/**
 * POST /api/v1/media/:id/bookmarks. The client names the bookmark (a new uuid): the mark
 * shows at once with its final id, and sending it again never makes a second one.
 */
export const createMediaBookmarkRequestSchema = z.strictObject({
  id: mediaBookmarkIdSchema,
  positionMs: z.number().int().min(0),
  note: bookmarkNoteSchema.optional(),
});
export type CreateMediaBookmarkRequest = z.infer<
  typeof createMediaBookmarkRequestSchema
>;

/** PATCH /api/v1/media/:id/bookmarks/:bookmarkId: the new note (null clears it). */
export const updateMediaBookmarkRequestSchema = z.strictObject({
  note: bookmarkNoteSchema,
});
export type UpdateMediaBookmarkRequest = z.infer<
  typeof updateMediaBookmarkRequestSchema
>;

/** A mark in "Meus marcadores", with the media it belongs to. */
export const myMediaBookmarkSchema = mediaBookmarkSchema.extend({
  mediaTitle: z.string(),
  mediaDurationMs: z.number().int().min(0).nullable(),
});
export type MyMediaBookmark = z.infer<typeof myMediaBookmarkSchema>;

/** GET /api/v1/media/bookmarks: the person's marks in every media they still see. */
export const myMediaBookmarkListSchema = z.object({
  items: z.array(myMediaBookmarkSchema),
});

/** True when a file name ends with an accepted audio extension. */
export function hasAcceptedAudioExtension(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return false;
  const extension = fileName.slice(dot + 1).toLowerCase();
  return (MEDIA_UPLOAD_EXTENSIONS as readonly string[]).includes(extension);
}

/* ---------- The media worker protocol (ADR 0022 §3) ---------- */

/** Converting for the browser (VM worker) and transcribing (a paired transcriber, ADR 0023). */
export const MEDIA_JOB_KINDS = ['transcode', 'transcribe'] as const;
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
  kind: z.literal('transcode'),
  mediaId: mediaIdSchema,
  attempt: z.number().int().min(1),
  sourcePath: z.string().min(1),
  targetPath: z.string().min(1),
  /** Where the 16 kHz mono FLAC for the transcriber goes (ADR 0022 §4); absent from older APIs. */
  flacTargetPath: z.string().min(1).optional(),
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
  /**
   * Bytes of the 16 kHz mono FLAC made in the same run for the transcriber (ADR 0022 §4),
   * at the work path with `.flac`; absent from a worker that made none.
   */
  flacBytes: z.number().int().min(1).optional(),
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

/**
 * A leased transcode job: the paths are relative to the shared media directory (the VM
 * worker). A transcribe job (below) is fetched over HTTP instead.
 */
export const transcribeJobSchema = z.object({
  id: mediaJobIdSchema,
  leaseId: z.uuid(),
  kind: z.literal('transcribe'),
  mediaId: mediaIdSchema,
  attempt: z.number().int().min(1),
  leaseMs: z.number().int().min(1),
  /** Known once converted; null for an item converted before durations were kept. */
  durationMs: z.number().int().min(0).nullable(),
  /** GET it (with `?leaseId=`) for the job's 16 kHz mono FLAC (or the audio rendition). */
  audioPath: z.string().min(1),
});
export type TranscribeJob = z.infer<typeof transcribeJobSchema>;

/** POST …/jobs/lease answers one of the two, by the kinds the token may lease. */
export const leasedJobSchema = z.union([workerJobSchema, transcribeJobSchema]);
export type LeasedWorkerJob = z.infer<typeof leasedJobSchema>;

/** A transcriber is "on" when seen within this window (FR-1: the last hour). */
export const TRANSCRIBER_ONLINE_MS = 60 * 60 * 1000;

/* ---------- Transcribers: paired workers ("Transcritores", masters only) ---------- */

export const transcriberIdSchema = z.uuid();

export const transcriberSchema = z.object({
  id: transcriberIdSchema,
  name: z.string().min(1).max(60),
  kinds: z.array(mediaJobKindSchema),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
  /** Seen within TRANSCRIBER_ONLINE_MS. */
  online: z.boolean(),
  /** The item it holds now, if any. */
  currentJob: z
    .object({ mediaId: mediaIdSchema, title: z.string() })
    .nullable(),
});
export type Transcriber = z.infer<typeof transcriberSchema>;

export const transcriberListSchema = z.object({
  items: z.array(transcriberSchema),
});
export type TranscriberList = z.infer<typeof transcriberListSchema>;

/** POST /api/v1/media/transcribers: the name the Mac goes by. */
export const pairTranscriberRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
});
export type PairTranscriberRequest = z.infer<
  typeof pairTranscriberRequestSchema
>;

/** The answer to pairing: the token, shown this once and never again (BR-1). */
export const pairedTranscriberSchema = z.object({
  transcriber: transcriberSchema,
  token: z.string().min(32),
});
export type PairedTranscriber = z.infer<typeof pairedTranscriberSchema>;

/** GET /api/v1/media-worker/terms: the term list put in every chunk's prompt. */
export const transcriptionTermsSchema = z.object({
  version: z.number().int().min(1),
  terms: z.array(z.string().min(1)),
});
export type TranscriptionTerms = z.infer<typeof transcriptionTermsSchema>;

/*
 * The raw result, as the transcriber produced it (ADR 0023 §3-4): one entry per chunk with
 * its offset in the track, each holding whisper's own output. Unknown keys are kept: the
 * file is stored as received and is the source of truth for every later derivation.
 */
const finite = z.number().refine(Number.isFinite);
export const rawWordSchema = z.looseObject({
  word: z.string(),
  start: finite,
  end: finite,
  probability: finite.nullable().optional(),
});
export const rawSegmentSchema = z.looseObject({
  start: finite,
  end: finite,
  text: z.string(),
  avg_logprob: finite.nullable().optional(),
  compression_ratio: finite.nullable().optional(),
  no_speech_prob: finite.nullable().optional(),
  temperature: finite.nullable().optional(),
  words: z.array(rawWordSchema).optional(),
});
export const rawChunkSchema = z.looseObject({
  /** Seconds from the start of the track. */
  offset: finite.min(0),
  end: finite.min(0),
  result: z.looseObject({ segments: z.array(rawSegmentSchema) }),
});
export const rawTranscriptSchema = z.looseObject({
  chunks: z.array(rawChunkSchema),
});
export type RawTranscript = z.infer<typeof rawTranscriptSchema>;
export type RawSegment = z.infer<typeof rawSegmentSchema>;

/** POST /api/v1/media-worker/jobs/:id/transcript: the raw result of a transcribe job. */
export const completeTranscribeRequestSchema = leaseOwnerSchema.extend({
  provider: z.enum(['mlx-whisper']),
  model: z.string().min(1).max(200),
  /** The worker's parameter set (VAD, temperatures, …), versioned in one config file. */
  parametersVersion: z.string().min(1).max(40),
  parameters: z.record(z.string(), z.unknown()),
  /** The term list version the prompts used (GET …/terms). */
  termsVersion: z.number().int().min(1),
  /** `skipped` when speech was under 40 % of the track (BR-4). */
  vad: z.enum(['applied', 'skipped']),
  speechRatio: z.number().min(0).max(1),
  /** Wall time of the transcription on the worker. */
  elapsedMs: z.number().int().min(0),
  raw: rawTranscriptSchema,
});
export type CompleteTranscribeRequest = z.infer<
  typeof completeTranscribeRequestSchema
>;

/** The largest raw result the API takes (an hour of speech is a few MB). */
export const MAX_RAW_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
