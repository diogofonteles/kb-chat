import { z } from 'zod';
import { levelRefSchema } from './access-levels.js';
import {
  KB_PUBLISH_MAX_BUDGET_USD,
  kbCollectionSchema,
  leasedJobSchema,
  mediaJobIdSchema,
  mediaSha256Schema,
} from './media.js';
import { topicSlugSchema } from './topics.js';

/* ---------- Documents and links sent from the app (KBC-149, ADR 0040) ---------- */

/** The largest document one upload may send: a scanned book with its images. */
export const DOCUMENT_UPLOAD_MAX_BYTES = 300 * 1024 * 1024;

/** What a document can be: what `kb-map convert` takes (KBC-148). Audio goes to the library. */
export const DOCUMENT_UPLOAD_EXTENSIONS = [
  'pdf',
  'docx',
  'doc',
  'pptx',
  'ppt',
  'xlsx',
  'xls',
  'odt',
  'rtf',
  'epub',
  'html',
  'htm',
  'csv',
  'json',
  'jsonl',
  'png',
  'jpg',
  'jpeg',
  'tif',
  'tiff',
  'webp',
  'txt',
  'md',
] as const;

export function hasDocumentExtension(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  const extension = name.slice(dot + 1).toLowerCase();
  return (DOCUMENT_UPLOAD_EXTENSIONS as readonly string[]).includes(extension);
}

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

/** A YouTube link goes through the transcriber as a media item (KBC-142 BR-5). */
export function isYoutubeUrl(url: string): boolean {
  try {
    return YOUTUBE_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** A web link: http(s) with a host, nothing else (no file:, no credentials in it). */
export const documentLinkSchema = z
  .url({ protocol: /^https?$/, hostname: z.regexes.domain })
  .max(2_000)
  .refine((url) => {
    const parsed = new URL(url);
    return parsed.username === '' && parsed.password === '';
  }, 'A link with credentials is refused');

/* ---------- One inclusion (batch) and its ceiling (KBC-009 R3) ---------- */

/** What one inclusion may spend when the person does not say. */
export const DOCUMENT_BATCH_DEFAULT_USD = 0.5;
export const DOCUMENT_BATCH_MIN_USD = 0.05;
export const DOCUMENT_BATCH_MAX_USD = 5;

const batchCapSchema = z
  .number()
  .min(DOCUMENT_BATCH_MIN_USD)
  .max(DOCUMENT_BATCH_MAX_USD);

/** The inclusion this item belongs to: the same id for everything sent together. */
export const documentBatchRequestSchema = z.strictObject({
  id: z.uuid(),
  capUsd: batchCapSchema,
});
export type DocumentBatchRequest = z.infer<typeof documentBatchRequestSchema>;

/** An inclusion as the screen shows it: its ceiling and what it already spent. */
export const documentBatchSchema = z.object({
  id: z.uuid(),
  capUsd: z.number(),
  spentUsd: z.number().min(0),
});
export type DocumentBatch = z.infer<typeof documentBatchSchema>;

/** PATCH /api/v1/document-batches/:id: a new ceiling (what waited for it goes on). */
export const changeDocumentBatchRequestSchema = z.strictObject({
  capUsd: batchCapSchema,
});
export type ChangeDocumentBatchRequest = z.infer<
  typeof changeDocumentBatchRequestSchema
>;

/**
 * POST /api/v1/topics/:topic/documents (FR-1): a file announced (its bytes go by tus to the
 * upload's `uploadUrl`) or a link. `level` is required in a collection with levels.
 */
export const createDocumentUploadRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('file'),
    name: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine(hasDocumentExtension, 'Not a document this app converts'),
    bytes: z.number().int().min(1).max(DOCUMENT_UPLOAD_MAX_BYTES),
    sha256: mediaSha256Schema,
    level: levelRefSchema.optional(),
    batch: documentBatchRequestSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('url'),
    url: documentLinkSchema,
    level: levelRefSchema.optional(),
    batch: documentBatchRequestSchema.optional(),
  }),
]);
export type CreateDocumentUploadRequest = z.infer<
  typeof createDocumentUploadRequestSchema
>;

/**
 * Where a sent document is (FR-2): receiving its bytes, received (waiting for the Mac),
 * converting, classifying, mapping (kb-map), mapped (done on the Mac, on its way to the app
 * with the next sync), ready (in the app's catalog: search and map), failed. A YouTube link
 * is transcribing while it goes through the media library.
 */
export const DOCUMENT_UPLOAD_STATES = [
  'receiving',
  'received',
  'converting',
  'transcribing',
  'classifying',
  'mapping',
  'mapped',
  'ready',
  'failed',
] as const;
export const documentUploadStateSchema = z.enum(DOCUMENT_UPLOAD_STATES);
export type DocumentUploadState = z.infer<typeof documentUploadStateSchema>;

/** Why a document did not enter the collection: a code the screen says in words. */
export const DOCUMENT_UPLOAD_FAILURES = [
  /** The converter could not read it (an unreadable PDF, a page that would not load). */
  'conversion-failed',
  /** It converted to nothing usable (BR-3 of KBC-148). */
  'empty',
  /** kb refused or sent it to review (quarantine, quality). */
  'not-accepted',
  /** The Mac gave up after its attempts. */
  'gave-up',
  /** Its bytes never all arrived. */
  'upload-abandoned',
] as const;
export const documentUploadFailureSchema = z.enum(DOCUMENT_UPLOAD_FAILURES);
export type DocumentUploadFailure = z.infer<typeof documentUploadFailureSchema>;

/** A document of the collection, as a link to it. */
export const uploadedDocumentRefSchema = z.object({
  id: z.string().min(1).max(1024),
  title: z.string().max(500),
});
export type UploadedDocumentRef = z.infer<typeof uploadedDocumentRefSchema>;

export const documentUploadSchema = z.object({
  id: z.uuid(),
  topic: topicSlugSchema,
  kind: z.enum(['file', 'url', 'youtube']),
  /** The file's name, or the link. */
  name: z.string(),
  state: documentUploadStateSchema,
  failure: documentUploadFailureSchema.nullable(),
  /** The converter's or kb's words, for masters only; null for anyone else. */
  detail: z.string().nullable(),
  /** The document it became, once ready (or the one it repeats). */
  document: uploadedDocumentRefSchema.nullable(),
  /** A YouTube link's media item in the library. */
  mediaId: z.uuid().nullable(),
  /** A file: bytes announced and received so far. */
  bytes: z.number().int().min(0).nullable(),
  received: z.number().int().min(0).nullable(),
  /** tus target for the bytes, while `receiving`. */
  uploadUrl: z.string().nullable(),
  /** The inclusion it belongs to; null for one sent before inclusions had a ceiling. */
  batch: documentBatchSchema.nullable(),
  /** Why it waits although the Mac could take it: a spending ceiling was reached. */
  heldBy: z.enum(['batch-cap', 'month-cap']).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DocumentUpload = z.infer<typeof documentUploadSchema>;

/**
 * The answer to POST: the new upload, or (BR-3, FR-3) what is already in the collection:
 * the document (null when it is above the person's level) or the upload still on its way.
 */
export const createDocumentUploadResponseSchema = z.discriminatedUnion(
  'outcome',
  [
    z.object({ outcome: z.literal('created'), upload: documentUploadSchema }),
    z.object({
      outcome: z.literal('duplicate'),
      document: uploadedDocumentRefSchema.nullable(),
      upload: documentUploadSchema.nullable(),
    }),
  ],
);
export type CreateDocumentUploadResponse = z.infer<
  typeof createDocumentUploadResponseSchema
>;

/** GET /api/v1/document-uploads: "Documentos em processamento" (the person's own; masters all). */
export const documentUploadListSchema = z.object({
  items: z.array(documentUploadSchema),
});
export type DocumentUploadList = z.infer<typeof documentUploadListSchema>;

/* ---------- The Mac's side: the doc-ingest job ---------- */

export const docIngestSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('file'),
    name: z.string().min(1).max(255),
    bytes: z.number().int().min(1),
    sha256: mediaSha256Schema,
    /** GET it with `?leaseId=`: the file as sent. */
    filePath: z.string(),
  }),
  z.object({ kind: z.literal('url'), url: z.string() }),
  /** Downloaded on the Mac and given back as audio to `audioPath` (POST, octet-stream). */
  z.object({
    kind: z.literal('youtube'),
    url: z.string(),
    audioPath: z.string(),
  }),
]);
export type DocIngestSource = z.infer<typeof docIngestSourceSchema>;

export const docIngestJobSchema = z.object({
  id: mediaJobIdSchema,
  leaseId: z.uuid(),
  kind: z.literal('doc-ingest'),
  topic: topicSlugSchema,
  attempt: z.number().int().min(1),
  leaseMs: z.number().int().min(1),
  /** What kb may spend (classify, link) on the owner's key: the media month's ceiling. */
  budgetUsd: z.number().min(0).max(KB_PUBLISH_MAX_BUDGET_USD),
  source: docIngestSourceSchema,
  /** What `kb topic new` needs when the vault has no folder for it (as kb-publish). */
  collection: kbCollectionSchema.optional(),
});
export type DocIngestJob = z.infer<typeof docIngestJobSchema>;

/** Every job a worker may lease: the media ones and doc-ingest. */
export const workerLeasedJobSchema = z.union([
  ...leasedJobSchema.options,
  docIngestJobSchema,
]);
export type WorkerLeasedJob = z.infer<typeof workerLeasedJobSchema>;

const docLeaseSchema = z.strictObject({
  worker: z.string().min(1).max(100),
  leaseId: z.uuid(),
});

/** POST …/jobs/:id/doc-state: the step the Mac is on now (FR-2). */
export const docIngestStateRequestSchema = docLeaseSchema.extend({
  state: z.enum(['converting', 'classifying', 'mapping']),
});
export type DocIngestStateRequest = z.infer<typeof docIngestStateRequestSchema>;

/** POST …/jobs/:id/doc-result: how it ended; a failure says why (AC-4). */
export const docIngestResultRequestSchema = docLeaseSchema.extend({
  outcome: z.discriminatedUnion('state', [
    z.object({
      state: z.literal('ready'),
      document: uploadedDocumentRefSchema,
    }),
    z.object({
      state: z.literal('duplicate'),
      document: uploadedDocumentRefSchema,
    }),
    z.object({
      state: z.literal('failed'),
      failure: documentUploadFailureSchema.exclude([
        'gave-up',
        'upload-abandoned',
      ]),
      detail: z.string().max(2_000),
    }),
  ]),
  /** What kb spent on the owner's key, booked on the media month (ADR 0035 §11). */
  spendUsd: z.number().min(0).max(KB_PUBLISH_MAX_BUDGET_USD).default(0),
});
export type DocIngestResultRequest = z.infer<
  typeof docIngestResultRequestSchema
>;

/** The most audio a YouTube link may bring back (as an uploaded recording). */
export const DOC_INGEST_AUDIO_MAX_BYTES = 2 * 1024 * 1024 * 1024;
