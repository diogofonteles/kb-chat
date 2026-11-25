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

/** A web link: http(s) with a host, nothing else (no file:, no credentials in it). */
export const documentLinkSchema = z
  // `abort`: what is not a URL is refused here, never handed to the refinement to parse.
  .url({ protocol: /^https?$/, hostname: z.regexes.domain, abort: true })
  .max(2_000)
  .refine((url) => {
    // The format above refuses it already; this check runs all the same and must not throw.
    if (!URL.canParse(url)) return true;
    const parsed = new URL(url);
    return parsed.username === '' && parsed.password === '';
  }, 'A link with credentials is refused');

/* ---------- One inclusion (batch) and its ceiling (KBC-009 R3) ---------- */

/** What one inclusion may spend when the person does not say. */
export const DOCUMENT_BATCH_DEFAULT_USD = 0.5;
export const DOCUMENT_BATCH_MIN_USD = 0.05;
export const DOCUMENT_BATCH_MAX_USD = 100;

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

/** What a person may have waiting here at once (masters: the disk is the limit). */
export const DOCUMENT_WAITING_MAX_BYTES = 5 * 1024 ** 3;
/** The disk keeps at least this free: the rest of the app lives there too. */
export const DOCUMENT_DISK_RESERVE_BYTES = 5 * 1024 ** 3;

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
      .regex(/^\P{Cc}+$/u, 'A name has no control characters')
      .refine(hasDocumentExtension, 'Not a document this app converts'),
    bytes: z.number().int().min(1).max(DOCUMENT_UPLOAD_MAX_BYTES),
    sha256: mediaSha256Schema,
    level: levelRefSchema.optional(),
    batch: documentBatchRequestSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('url'),
    url: documentLinkSchema,
    /** What the sender says it is; left out, the address decides (recordingLinkKind). */
    as: z.enum(['page', 'recording']).optional(),
    /** How it is listed while on its way (the search's own title); else by its address. */
    title: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .regex(/^\P{Cc}+$/u)
      .optional(),
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
 * with the next sync), ready (in the app's catalog: search and map), failed. A list (channel,
 * playlist) is `choosing` once the Mac read it: the person says which ones enter (KBC-186). A recording link
 * is transcribing while it goes through the media library.
 */
export const DOCUMENT_UPLOAD_STATES = [
  'receiving',
  'received',
  'converting',
  'transcribing',
  'choosing',
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
  /** A live stream: there is no end to wait for. */
  'live',
  /** A recording past what the app takes back (2 GB). */
  'too-large',
  /** It converted to nothing usable (BR-3 of KBC-148). */
  'empty',
  /** kb refused or sent it to review (quarantine, quality). */
  'not-accepted',
  /** A recording past its sender's quota, or whose sender may not send here any more. */
  'not-allowed',
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

/** The most of a channel or playlist the Mac lists for the person to choose from. */
export const RECORDING_LIST_MAX = 5_000;

/** One recording of a list (KBC-186 R7), to be chosen before anything enters. */
export const recordingEntrySchema = z.object({
  url: documentLinkSchema,
  title: z.string().min(1).max(300),
  durationS: z.number().int().min(0).nullable(),
});
export type RecordingEntry = z.infer<typeof recordingEntrySchema>;

/**
 * Where a recording is in the library, once the Mac brought its sound: being converted,
 * waiting for the transcriber, being transcribed, being published, or waiting for a person.
 */
export const DOCUMENT_MEDIA_STEPS = [
  'preparing',
  'waiting',
  'transcribing',
  'publishing',
  'attention',
] as const;
export const documentMediaStepSchema = z.enum(DOCUMENT_MEDIA_STEPS);
export type DocumentMediaStep = z.infer<typeof documentMediaStepSchema>;

/** How far an item is (KBC-184): when the Mac took it, or its place in the Mac's line. */
export const documentProgressSchema = z.object({
  /** Since when the Mac has it; null while it waits, and once it ended. */
  startedAt: z.iso.datetime().nullable(),
  /** The Mac had it and went silent: since its last word. It goes on when the Mac is back. */
  stalledSince: z.iso.datetime().nullable().default(null),
  /** Its place among everything that waits for the Mac, anyone's; 1 is next. */
  position: z.number().int().min(1).nullable(),
  /** About when its turn comes; null while no Mac is seen (nobody knows). */
  startsInSeconds: z.number().int().min(0).nullable(),
  /** About how long one like it takes on the Mac, of what is still to be done. */
  takesSeconds: z.number().int().min(0).nullable(),
  /** A recording in the library: its step, and how far when it is known. */
  media: z
    .object({
      step: documentMediaStepSchema,
      percent: z.number().int().min(0).max(100).nullable(),
    })
    .nullable(),
});
export type DocumentProgress = z.infer<typeof documentProgressSchema>;

/** The Mac that puts what is sent into the collections, as the screen says it. */
export const documentWorkSchema = z.object({
  mac: z.object({
    /** None paired to publish, seen in the last minutes, or not. */
    state: z.enum(['none', 'off', 'on']),
    lastSeenAt: z.iso.datetime().nullable(),
    /** What else it does now: it takes one thing at a time. */
    doing: z.enum(['recording', 'publishing']).nullable().default(null),
  }),
  /** The Mac has an item now, whoever sent it. */
  busy: z.boolean(),
  /** Everything that waits for the Mac, whoever sent it. */
  waiting: z.number().int().min(0),
});
export type DocumentWork = z.infer<typeof documentWorkSchema>;

/**
 * What kb refused (its quarantine, BR-4: nothing is deleted), for the person who decides. `why`
 * is kb's own reason (`thin`, `paywall`, `off_topic`…); the excerpt is how the text begins.
 */
export const refusedDocumentSchema = z.object({
  why: z.string().max(60),
  excerpt: z.string().max(3_000),
  /** Only masters put it in the collection all the same. */
  acceptable: z.boolean(),
});
export type RefusedDocument = z.infer<typeof refusedDocumentSchema>;

export const documentUploadSchema = z.object({
  id: z.uuid(),
  topic: topicSlugSchema,
  kind: z.enum(['file', 'url', 'recording', 'list']),
  /** The file's name, or the link. */
  name: z.string(),
  state: documentUploadStateSchema,
  failure: documentUploadFailureSchema.nullable(),
  /** The converter's or kb's words, for masters only; null for anyone else. */
  detail: z.string().nullable(),
  /** The document it became, once ready (or the one it repeats). */
  document: uploadedDocumentRefSchema.nullable(),
  /** A recording link's media item in the library. */
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
  /** In the collection, and waiting for a person in kb's review queue. */
  review: z.boolean(),
  /** A list's recordings, while `choosing`; empty otherwise. */
  entryCount: z.number().int().min(0),
  /** Sent by the person who asks (masters see everyone's). */
  mine: z.boolean(),
  /** kb refused it, and it waits for a person's decision. */
  refused: refusedDocumentSchema.nullable().default(null),
  /** It failed, and the app still has what was sent: it can go again as it is. */
  retriable: z.boolean(),
  progress: documentProgressSchema,
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
  /** Null from an API that does not say it. */
  work: documentWorkSchema.nullable().default(null),
});
export type DocumentUploadList = z.infer<typeof documentUploadListSchema>;

/** POST /api/v1/document-uploads/clear-ready: what is ready leaves the list (not the collection). */
export const clearReadyUploadsRequestSchema = z.strictObject({
  /** The ones the person saw ready: what became ready since is seen first. */
  ids: z.array(z.uuid()).min(1).max(10_000),
});
export type ClearReadyUploadsRequest = z.infer<
  typeof clearReadyUploadsRequestSchema
>;
export const clearReadyUploadsResponseSchema = z.object({
  cleared: z.number().int().min(0),
});

/** GET /api/v1/document-uploads/:id/entries: what a list holds, to choose from (R7). */
export const recordingEntryListSchema = z.object({
  entries: z.array(recordingEntrySchema),
});
export type RecordingEntryList = z.infer<typeof recordingEntryListSchema>;

/** POST /api/v1/document-uploads/:id/choose: the list's recordings that enter (R7). */
export const chooseRecordingsRequestSchema = z.strictObject({
  urls: z.array(documentLinkSchema).min(1).max(RECORDING_LIST_MAX),
});
export type ChooseRecordingsRequest = z.infer<
  typeof chooseRecordingsRequestSchema
>;
export const chooseRecordingsResponseSchema = z.object({
  created: z.number().int().min(0),
  /** Already in the collection, or on their way. */
  already: z.number().int().min(0),
});
export type ChooseRecordingsResponse = z.infer<
  typeof chooseRecordingsResponseSchema
>;

/* ---------- What an inclusion will cost, before it is sent (KBC-186) ---------- */

/** What the estimate tells apart. */
export const CONTENT_COST_KINDS = [
  'document',
  'image',
  'page',
  'recording',
] as const;
export const contentCostKindSchema = z.enum(CONTENT_COST_KINDS);
export type ContentCostKind = z.infer<typeof contentCostKindSchema>;

/** One item of a kind: its usual cost and time on the Mac, and how many it is measured on. */
export const contentCostSchema = z.object({
  usd: z.number().min(0),
  seconds: z.number().min(0),
  /** 0: nothing of this kind was added here yet, so the first measurements are used. */
  samples: z.number().int().min(0),
});
export type ContentCost = z.infer<typeof contentCostSchema>;

/** GET /api/v1/document-uploads/costs: what each kind really took here, the latest ones. */
export const contentCostsSchema = z.record(
  contentCostKindSchema,
  contentCostSchema,
);
export type ContentCosts = z.infer<typeof contentCostsSchema>;

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
  /** A person said it enters all the same: kb takes it out of its quarantine (KBC-009). */
  z.object({ kind: z.literal('accept'), document: z.string() }),
  /** Downloaded on the Mac and given back as audio to `audioPath` (POST, octet-stream). */
  z.object({
    kind: z.literal('recording'),
    url: z.string(),
    audioPath: z.string(),
  }),
  /** Listed on the Mac and given back to `entriesPath` (POST, JSON). */
  z.object({
    kind: z.literal('list'),
    url: z.string(),
    entriesPath: z.string(),
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

/** POST …/jobs/:id/doc-entries: what a list holds, for the person to choose from. */
export const docIngestEntriesRequestSchema = docLeaseSchema.extend({
  entries: z.array(recordingEntrySchema).max(RECORDING_LIST_MAX),
});
export type DocIngestEntriesRequest = z.infer<
  typeof docIngestEntriesRequestSchema
>;

/** POST …/jobs/:id/doc-result: how it ended; a failure says why (AC-4). */
export const docIngestResultRequestSchema = docLeaseSchema.extend({
  outcome: z.discriminatedUnion('state', [
    z.object({
      state: z.literal('ready'),
      document: uploadedDocumentRefSchema,
      /** kb wrote it and put it in its own review queue: it is in the collection. */
      review: z.boolean().default(false),
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
      /** Only of `not-accepted`: what kb put in its quarantine. */
      refused: z
        .object({
          document: z
            .string()
            .max(500)
            .regex(/^raw\/_quarantine\/(?:[^/.][^/]*\/)*[^/.][^/]*\.md$/),
          reason: z.string().max(60),
          excerpt: z.string().max(3_000),
        })
        .optional(),
    }),
  ]),
  /** What kb spent on the owner's key, booked on the media month (ADR 0035 §11). */
  spendUsd: z.number().min(0).max(KB_PUBLISH_MAX_BUDGET_USD).default(0),
});
export type DocIngestResultRequest = z.infer<
  typeof docIngestResultRequestSchema
>;

/** The most audio a recording link may bring back (as an uploaded recording). */
export const DOC_INGEST_AUDIO_MAX_BYTES = 2 * 1024 * 1024 * 1024;
