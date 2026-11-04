import { z } from 'zod';
import { transcriptTermListSchema } from './media-terms.js';
import { authorSchema, authorSlugSchema } from './authors.js';
import { topicSlugSchema } from './topics.js';
import { MAX_VOICES, voiceIndexSchema } from './voice-index.js';
import {
  voiceMatchSchema,
  voiceProfileJobSchema,
  voiceProfileSuggestionSchema,
} from './voice-prints.js';

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

/**
 * Who a media item is by (KBC-049): one of its collection's authors, or null for
 * "Outros autores" (no author informed).
 */
export const mediaAuthorSchema = authorSchema.nullable();
export type MediaAuthor = z.infer<typeof mediaAuthorSchema>;

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
  /** The newest attempt failed and the current transcript stayed (KBC-040 BR-3). */
  lastAttemptFailed: z.boolean().default(false),
});
export type MediaTranscription = z.infer<typeof mediaTranscriptionSchema>;

export const mediaItemSchema = z.object({
  id: mediaIdSchema,
  topic: topicSlugSchema,
  title: z.string().min(1).max(200),
  author: mediaAuthorSchema,
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
  /**
   * The person may change its details (KBC-050 BR-1). Defaults to false so a web newer than
   * its API still reads the item.
   */
  canEdit: z.boolean().default(false),
  /** A master may queue a new transcription: it is ready and none is pending (KBC-040 FR-3). */
  canTranscribeAgain: z.boolean().default(false),
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
  /** An author of the collection (registered first with POST …/authors), or null. */
  author: authorSlugSchema.nullable(),
  fileName: z.string().min(1).max(255),
  bytes: z.number().int().min(1).max(MEDIA_MAX_UPLOAD_BYTES),
});
export type CreateMediaRequest = z.infer<typeof createMediaRequestSchema>;

/** PATCH /api/v1/media/:id (KBC-050 FR-1): what changes; what is left out stays. */
export const updateMediaRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  /** An author of the collection it ends up in, or null for "Outros autores". */
  author: authorSlugSchema.nullable().optional(),
  /** The collection to move it to. */
  topic: topicSlugSchema.optional(),
});
export type UpdateMediaRequest = z.infer<typeof updateMediaRequestSchema>;

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
  /** "Encurtar silêncios" (KBC-044): off until the person turns it on (BR-2). */
  skipSilences: z.boolean(),
});
export type MediaPreferences = z.infer<typeof mediaPreferencesSchema>;

/**
 * PUT /api/v1/media/preferences. `skipSilences` may be absent (a client from before
 * KBC-044): the account then keeps its stored choice instead of turning it off.
 */
export const saveMediaPreferencesRequestSchema = mediaPreferencesSchema.extend({
  skipSilences: z.boolean().optional(),
});
export type SaveMediaPreferencesRequest = z.infer<
  typeof saveMediaPreferencesRequestSchema
>;

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

/**
 * Converting for the browser and measuring its silences (VM worker, KBC-044),
 * transcribing (a paired transcriber, ADR 0023), separating the voices of a transcribed
 * recording (a paired transcriber, ADR 0029 §1) and computing its waveform peaks (VM worker,
 * ADR 0029 §4).
 */
export const MEDIA_JOB_KINDS = [
  'transcode',
  'transcribe',
  'silences',
  'diarize',
  'waveform',
  'voice-profile',
] as const;
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

/** More than a collection's speakers; the bound only keeps a heartbeat small. */
export const MAX_HELD_VOICE_PROFILES = 1_000;

export const heartbeatRequestSchema = leaseOwnerSchema.extend({
  progress: z.number().int().min(0).max(100).nullable(),
  /** The profiles whose prints this job holds in memory (KBC-071 BR-2). */
  voiceProfiles: z.array(z.uuid()).max(MAX_HELD_VOICE_PROFILES).optional(),
});
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

/** A heartbeat with nothing to say is 204; this one says which prints to drop now. */
export const heartbeatResponseSchema = z.strictObject({
  revokedVoiceProfiles: z.array(z.uuid()),
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

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

/* ---------- Silence maps (KBC-044, ADR 0025 §3) ---------- */

/** One pause of a media item, in ms of the original timeline (end after start). */
export const silenceIntervalSchema = z
  .object({
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
  })
  .refine((span) => span.startMs < span.endMs, {
    error: 'startMs must come before endMs',
  });
export type SilenceInterval = z.infer<typeof silenceIntervalSchema>;

/** The most pauses one map holds (a 4 h recording with a pause every 2 s is 7 200). */
export const MAX_SILENCE_INTERVALS = 20_000;

/**
 * How the worker measures silences (FR-1): ffmpeg `silencedetect` at −35 dB for 1.0 s.
 * The version names this set: a map of an older version is measured again (backfill).
 */
export const SILENCE_DETECTOR = {
  version: 1,
  noiseDb: -35,
  minSilenceMs: 1_000,
} as const;

export const silenceDetectorSchema = z.object({
  version: z.number().int().min(1),
  noiseDb: z.number().max(0),
  minSilenceMs: z.number().int().min(1),
});

/** A leased silences job (VM worker): measure the audio rendition at `sourcePath`. */
export const silencesJobSchema = z.object({
  id: mediaJobIdSchema,
  leaseId: z.uuid(),
  kind: z.literal('silences'),
  mediaId: mediaIdSchema,
  attempt: z.number().int().min(1),
  /** The audio rendition, relative to the shared media directory. */
  sourcePath: z.string().min(1),
  leaseMs: z.number().int().min(1),
  detector: silenceDetectorSchema,
});
export type SilencesJob = z.infer<typeof silencesJobSchema>;

/**
 * How the worker measures a waveform (KBC-066): the loudest sample of every 100 ms as one
 * byte. The version names this set: a waveform of an older one is measured again.
 */
export const WAVEFORM = { version: 1, peaksPerSecond: 10 } as const;

/** The longest recording's peaks in base64 (12 h at 10 per second, 4 chars per 3 bytes). */
export const MAX_WAVEFORM_BASE64 = 576_000;

/** A leased waveform job (VM worker): measure the audio rendition at `sourcePath`. */
export const waveformJobSchema = silencesJobSchema
  .omit({ detector: true })
  .extend({
    kind: z.literal('waveform'),
    version: z.number().int().min(1),
    peaksPerSecond: z.number().int().min(1),
  });
export type WaveformJob = z.infer<typeof waveformJobSchema>;

/** The jobs the VM worker leases: conversions, silence maps and waveforms. */
export const vmWorkerJobSchema = z.discriminatedUnion('kind', [
  workerJobSchema,
  silencesJobSchema,
  waveformJobSchema,
]);
export type VmWorkerJob = z.infer<typeof vmWorkerJobSchema>;

/** POST /api/v1/media-worker/jobs/:id/silences: the pauses found, in order, not overlapping. */
export const completeSilencesRequestSchema = leaseOwnerSchema.extend({
  /** The detector version the job asked for. */
  detectorVersion: z.number().int().min(1),
  intervals: z.array(silenceIntervalSchema).max(MAX_SILENCE_INTERVALS),
  /** Wall time of the detection on the worker (NFR-1). */
  elapsedMs: z.number().int().min(0),
});
export type CompleteSilencesRequest = z.infer<
  typeof completeSilencesRequestSchema
>;

const peaksSchema = z.base64().max(MAX_WAVEFORM_BASE64);

/** POST /api/v1/media-worker/jobs/:id/waveform: one byte per peak, in base64. */
export const completeWaveformRequestSchema = leaseOwnerSchema.extend({
  version: z.number().int().min(1),
  peaks: peaksSchema,
  /** Wall time on the worker (NFR-2: ≤ 20 s per hour of audio). */
  elapsedMs: z.number().int().min(0),
});
export type CompleteWaveformRequest = z.infer<
  typeof completeWaveformRequestSchema
>;

/** GET /api/v1/media/:id/waveform (for whoever may listen): the peaks, empty until measured. */
export const mediaWaveformSchema = z.object({
  status: z.enum(['pending', 'ready', 'failed']),
  peaksPerSecond: z.number().int().min(1),
  peaks: peaksSchema,
});
export type MediaWaveform = z.infer<typeof mediaWaveformSchema>;

/**
 * Whether a media item's silence map exists: still to be measured (FR-1: after the
 * conversion), measured, or given up after the queue's last attempt (AC-5).
 */
export const SILENCE_MAP_STATUSES = ['pending', 'ready', 'failed'] as const;

/**
 * GET /api/v1/media/:id/silences (FR-3, with the stream's access rules): the pauses of
 * the current map, in order; empty while pending. Also the base for track snapping
 * (KBC-066).
 */
export const mediaSilencesSchema = z.object({
  status: z.enum(SILENCE_MAP_STATUSES),
  /** The detector version of the map; null while pending. */
  version: z.number().int().min(1).nullable(),
  /** The shortest pause the map holds. */
  minSilenceMs: z.number().int().min(1),
  intervals: z.array(silenceIntervalSchema),
});
export type MediaSilenceStatus = (typeof SILENCE_MAP_STATUSES)[number];
export type MediaSilences = z.infer<typeof mediaSilencesSchema>;

export { MAX_VOICES, voiceIndexSchema };
export const voiceCountSchema = z.number().int().min(1).max(MAX_VOICES);

/** A leased voice separation (KBC-064): the audio as for a transcription, and the hint. */
export const diarizeJobSchema = transcribeJobSchema.extend({
  kind: z.literal('diarize'),
  /** How many voices the person said there are (BR-4); null lets the model estimate. */
  voices: voiceCountSchema.nullable(),
});
export type DiarizeJob = z.infer<typeof diarizeJobSchema>;

/** POST …/jobs/lease answers one of these, by the kinds the token may lease. */
export const leasedJobSchema = z.union([
  workerJobSchema,
  transcribeJobSchema,
  silencesJobSchema,
  diarizeJobSchema,
  waveformJobSchema,
  voiceProfileJobSchema,
]);
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
  /** The item it holds now, if any, and what it does to it (KBC-064: transcribe or separate). */
  currentJob: z
    .object({
      mediaId: mediaIdSchema,
      title: z.string(),
      kind: mediaJobKindSchema.default('transcribe'),
    })
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
const inOrder = (span: { start: number; end: number }) =>
  span.start <= span.end;
const ORDER = { error: 'start must not come after end' };

/** Bounds of one raw result (an hour of speech is ~10 000 words in ~150 chunks). */
export const RAW_TRANSCRIPT_LIMITS = {
  chunks: 20_000,
  segmentsPerChunk: 2_000,
  wordsPerSegment: 2_000,
  segmentText: 10_000,
  wordText: 200,
} as const;

export const rawWordSchema = z
  .looseObject({
    word: z.string().max(RAW_TRANSCRIPT_LIMITS.wordText),
    start: finite,
    end: finite,
    probability: finite.nullable().optional(),
  })
  .refine(inOrder, ORDER);
export const rawSegmentSchema = z
  .looseObject({
    start: finite,
    end: finite,
    text: z.string().max(RAW_TRANSCRIPT_LIMITS.segmentText),
    avg_logprob: finite.nullable().optional(),
    compression_ratio: finite.nullable().optional(),
    no_speech_prob: finite.nullable().optional(),
    temperature: finite.nullable().optional(),
    words: z
      .array(rawWordSchema)
      .max(RAW_TRANSCRIPT_LIMITS.wordsPerSegment)
      .optional(),
  })
  .refine(inOrder, ORDER);
export const rawChunkSchema = z
  .looseObject({
    /** Seconds from the start of the track. */
    offset: finite.min(0),
    end: finite.min(0),
    result: z.looseObject({
      segments: z
        .array(rawSegmentSchema)
        .max(RAW_TRANSCRIPT_LIMITS.segmentsPerChunk),
    }),
  })
  .refine((chunk) => chunk.offset <= chunk.end, ORDER);
export const rawTranscriptSchema = z.looseObject({
  chunks: z.array(rawChunkSchema).max(RAW_TRANSCRIPT_LIMITS.chunks),
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

/* ---------- Voices of a recording (KBC-064, ADR 0029 §1) ---------- */

/** The engines a transcriber may separate voices with (the model is swappable). */
export const DIARIZATION_ENGINES = ['senko', 'pyannote'] as const;

/** The most turns one separation may send (an hour of debate is a few thousand). */
export const MAX_SPEAKER_TURNS = 100_000;

/**
 * One turn as the transcriber found it: seconds from the start, and the engine's own name
 * for the voice. Strict: a voice print (embedding) has no field to travel in (BR-1).
 */
export const rawSpeakerTurnSchema = z
  .strictObject({
    start: finite.min(0),
    end: finite.min(0),
    voice: z.string().min(1).max(40),
  })
  .refine(inOrder, ORDER);
export type RawSpeakerTurn = z.infer<typeof rawSpeakerTurnSchema>;

/**
 * The engine's parameters, plain values only (BR-1): no array or object can carry a vector,
 * so a voice print has nowhere to hide in the stored row or raw file.
 */
export const diarizeParametersSchema = z
  .record(
    z.string().min(1).max(40),
    z.union([z.string().max(200), finite, z.boolean(), z.null()]),
  )
  .refine((parameters) => Object.keys(parameters).length <= 30, {
    error: 'at most 30 parameters',
  });

/** POST /api/v1/media-worker/jobs/:id/diarization: the turns of a diarize job, nothing else. */
export const completeDiarizeRequestSchema = leaseOwnerSchema.extend({
  engine: z.enum(DIARIZATION_ENGINES),
  model: z.string().min(1).max(200),
  parametersVersion: z.string().min(1).max(40),
  parameters: diarizeParametersSchema,
  /** The hint the job carried (BR-4); the API checks the job's own, not this one. */
  requestedVoices: voiceCountSchema.nullable(),
  elapsedMs: z.number().int().min(0),
  raw: z.strictObject({
    turns: z.array(rawSpeakerTurnSchema).max(MAX_SPEAKER_TURNS),
  }),
  /** The closest voice profile per voice (KBC-071 FR-3), kept out of `raw`. */
  voiceMatches: z.array(voiceMatchSchema).max(MAX_VOICES).optional(),
});
export type CompleteDiarizeRequest = z.infer<
  typeof completeDiarizeRequestSchema
>;

/** The largest separation result the API takes. */
export const MAX_DIARIZATION_BYTES = 16 * 1024 * 1024;

/** POST /api/v1/media/:id/diarize: "Separar vozes", with the optional number of voices. */
export const diarizeRequestSchema = z.strictObject({
  voices: voiceCountSchema.nullable().optional(),
});
export type DiarizeRequest = z.infer<typeof diarizeRequestSchema>;

/** Where a media item's voice separation is: never asked, waiting, running, done, given up. */
export const DIARIZATION_STATUSES = [
  'none',
  'waiting',
  'diarizing',
  'done',
  'failed',
] as const;
export const diarizationStatusSchema = z.enum(DIARIZATION_STATUSES);
export type DiarizationStatus = z.infer<typeof diarizationStatusSchema>;

export const speakerTurnSchema = z.object({
  voice: voiceIndexSchema,
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
});
export type SpeakerTurn = z.infer<typeof speakerTurnSchema>;

/**
 * The voice of one segment of the current transcript (the one that speaks most of it), in
 * the transcript's order; null where no voice was found (silence, music).
 */
export const segmentVoiceSchema = z.object({
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  voice: voiceIndexSchema.nullable(),
});
export type SegmentVoice = z.infer<typeof segmentVoiceSchema>;

/** Who a voice is, as read (KBC-065 BR-2, BR-6): `name` is null but for a `person`. */
export const VOICE_LABEL_KINDS = ['person', 'audience', 'unnamed'] as const;
export const voiceLabelSchema = z.object({
  voice: voiceIndexSchema,
  kind: z.enum(VOICE_LABEL_KINDS),
  speakerId: z.uuid().nullable(),
  name: z.string().min(1).nullable(),
  /** The collection's main author: shown with ✦ (BR-2). */
  main: z.boolean(),
});
export type VoiceLabel = z.infer<typeof voiceLabelSchema>;

/** A voice joined to another (KBC-065 FR-2), kept so the join can be undone. */
export const mergedVoiceSchema = z.object({
  voice: voiceIndexSchema,
  into: voiceIndexSchema,
});
export type MergedVoice = z.infer<typeof mergedVoiceSchema>;

/**
 * The current separation of a recording, read against its current transcript. Voices joined
 * by a person read as one everywhere: `turns`, `voices`, `voiceCount` and `segments`.
 */
export const diarizationSchema = z.object({
  version: z.number().int().min(1),
  createdAt: z.iso.datetime(),
  /** The transcript the voices are shown on (the current one). */
  transcriptVersion: z.number().int().min(1),
  /** Made on an older transcript (BR-3): shown with "Feita sobre uma transcrição anterior". */
  staleTranscript: z.boolean(),
  requestedVoices: voiceCountSchema.nullable(),
  voiceCount: z.number().int().min(0).max(MAX_VOICES),
  voices: z.array(
    z.object({
      voice: voiceIndexSchema,
      speakingMs: z.number().int().min(0),
    }),
  ),
  turns: z.array(speakerTurnSchema),
  segments: z.array(segmentVoiceSchema),
  /** One per voice in `voices` (KBC-065). */
  labels: z.array(voiceLabelSchema),
  merged: z.array(mergedVoiceSchema),
  /** A new separation's names wait for "Confirmar nomes" (BR-5). */
  namesPending: z.boolean(),
});
export type Diarization = z.infer<typeof diarizationSchema>;

/** GET /api/v1/media/:id/speakers: for `media-edit` only (FR-4). */
export const mediaSpeakersSchema = z.object({
  mediaId: mediaIdSchema,
  status: diarizationStatusSchema,
  /** A transcriber that separates voices is on, off, or none is marked for it (AC-9). */
  transcriber: transcriberPresenceSchema,
  transcriberOffSince: z.iso.datetime().nullable(),
  /** "Separar vozes" is possible now: a current transcript and nothing queued or running. */
  canRequest: z.boolean(),
  /** The newest separation; null before the first. */
  diarization: diarizationSchema.nullable(),
  /** Names suggested by voice, waiting for a person (KBC-071). */
  voiceSuggestions: z.array(voiceProfileSuggestionSchema).default([]),
});
export type MediaSpeakers = z.infer<typeof mediaSpeakersSchema>;

/**
 * The voices on GET …/transcript (KBC-064 FR-4): the current separation, its voice per
 * segment carried by the transcript's own segments.
 */
export const transcriptSpeakersSchema = diarizationSchema.omit({
  segments: true,
});
export type TranscriptSpeakers = z.infer<typeof transcriptSpeakersSchema>;

/* ---------- Transcript for reading and subtitles (KBC-038) ---------- */

/**
 * One segment of the current transcript, already filtered (ADR 0023 §5), times in ms. For
 * whoever edits recordings, the voice that speaks most of it once voices are separated
 * (KBC-064 FR-3; null: none found); absent for everyone else.
 */
export const transcriptSegmentSchema = z.object({
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  text: z.string(),
  voice: voiceIndexSchema.nullable().optional(),
});
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

/** GET /api/v1/media/:id/transcript: the current version (the newest, KBC-036 BR-3). */
export const mediaTranscriptSchema = z.object({
  mediaId: mediaIdSchema,
  version: z.number().int().min(1),
  /** `low`: always shown with the notice (KBC-036 BR-5, KBC-038 BR-2). */
  confidence: transcriptConfidenceSchema,
  segments: z.array(transcriptSegmentSchema),
  /** The current separation (KBC-064 FR-4): only for `media-edit`, once there is one. */
  speakers: transcriptSpeakersSchema.optional(),
  /**
   * Who each voice is, for `media-speakers` or `media-edit` once voices are separated
   * (KBC-065 FR-4); for whoever only listens, names waiting for confirmation read as unnamed.
   */
  voiceNames: z.array(voiceLabelSchema).optional(),
  /** The term list it was made with: for masters only (KBC-040 FR-4). */
  termList: transcriptTermListSchema.optional(),
});
export type MediaTranscript = z.infer<typeof mediaTranscriptSchema>;

/* ---------- Naming the voices (KBC-065, ADR 0029 §2) ---------- */

/** Which separation a change is about: voice numbers mean nothing in another version. */
export const separationVersionSchema = z.number().int().min(1);

/** PUT /api/v1/media/:id/voices/:voice: a speaker, the audience, or back to no name. */
export const nameVoiceRequestSchema = z
  .strictObject({
    version: separationVersionSchema,
    speakerId: z.uuid().nullable(),
    audience: z.boolean(),
  })
  .refine((one) => !(one.audience && one.speakerId !== null), {
    error: 'a voice is a speaker or the audience, not both',
  });
export type NameVoiceRequest = z.infer<typeof nameVoiceRequestSchema>;

/** POST /api/v1/media/:id/voices/merge: `voice` becomes part of `into`. */
export const mergeVoicesRequestSchema = z
  .strictObject({
    version: separationVersionSchema,
    voice: voiceIndexSchema,
    into: voiceIndexSchema,
  })
  .refine((one) => one.voice !== one.into, {
    error: 'a voice cannot join itself',
  });
export type MergeVoicesRequest = z.infer<typeof mergeVoicesRequestSchema>;

/** POST /api/v1/media/:id/voices/split: undoes a join. */
export const splitVoiceRequestSchema = z.strictObject({
  version: separationVersionSchema,
  voice: voiceIndexSchema,
});
export type SplitVoiceRequest = z.infer<typeof splitVoiceRequestSchema>;

/** POST /api/v1/media/:id/voices/confirm: "Confirmar nomes" (BR-5). */
export const confirmVoicesRequestSchema = z.strictObject({
  version: separationVersionSchema,
});
export type ConfirmVoicesRequest = z.infer<typeof confirmVoicesRequestSchema>;

/** PATCH /api/v1/media/transcribers/:id: what a paired transcriber may do (FR-6). */
export const TRANSCRIBER_KINDS = [
  'transcribe',
  'diarize',
  'voice-profile',
] as const;
export const updateTranscriberRequestSchema = z.strictObject({
  kinds: z.array(z.enum(TRANSCRIBER_KINDS)).min(1),
});
export type UpdateTranscriberRequest = z.infer<
  typeof updateTranscriberRequestSchema
>;
