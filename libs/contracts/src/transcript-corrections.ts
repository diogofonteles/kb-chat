import { z } from 'zod';
import { mediaIdSchema } from './media.js';

/* ---------- Word corrections (KBC-093, ADR 0034) ---------- */

/** One correction names 1 to 5 consecutive words of one segment (BR-1). */
export const CORRECTION_MAX_WORDS = 5;
/** The new text, once its spaces are tidied (BR-3). */
export const CORRECTION_MAX_CHARS = 80;
/** Occurrences one "Corrigir todas" writes at most (BR-12). */
export const CORRECTION_MAX_BATCH = 200;

/** Generous bounds for the shape only: the service answers 409/422 by the rules (AC-6, AC-8). */
const positionSchema = z.number().int().min(0).max(10_000_000);
const countSchema = z.number().int().min(1).max(50);
const expectedSchema = z.array(z.string().max(500)).min(1).max(50);
const typedTextSchema = z.string().max(2_000);

/** The words a correction targets, as the person saw them (`expected`, BR-6). */
export const correctionTargetSchema = z
  .strictObject({
    position: positionSchema,
    count: countSchema,
    expected: expectedSchema,
  })
  .refine((one) => one.expected.length === one.count, {
    error: 'expected names one text per word',
  });
export type CorrectionTarget = z.infer<typeof correctionTargetSchema>;

/** POST /api/v1/media/:id/transcript/corrections (FR-5). */
export const transcriptCorrectionRequestSchema = z
  .strictObject({
    /** The transcript version the person saw: another one answers 412 (BR-6). */
    version: z.number().int().min(1),
    position: positionSchema,
    count: countSchema,
    expected: expectedSchema,
    text: typedTextSchema,
  })
  .refine((one) => one.expected.length === one.count, {
    error: 'expected names one text per word',
  });
export type TranscriptCorrectionRequest = z.infer<
  typeof transcriptCorrectionRequestSchema
>;

/** POST …/transcript/corrections/batch: "Corrigir todas" (FR-12). */
export const transcriptCorrectionBatchRequestSchema = z.strictObject({
  version: z.number().int().min(1),
  /** The client's key for this group: a retry with it writes nothing again (BR-13). */
  key: z.uuid(),
  text: typedTextSchema,
  items: z.array(correctionTargetSchema).max(1_000),
});
export type TranscriptCorrectionBatchRequest = z.infer<
  typeof transcriptCorrectionBatchRequestSchema
>;

export const correctionKindSchema = z.enum(['correct', 'undo', 'carried']);
export type CorrectionKind = z.infer<typeof correctionKindSchema>;

/**
 * `active`: in force; `undone`: an undo restored it; `carried`: reapplied on a newer version
 * (`carriedTo`); `not-carried`: the newer version says something else there (`found`).
 */
export const correctionStateSchema = z.enum([
  'active',
  'undone',
  'carried',
  'not-carried',
]);
export type CorrectionState = z.infer<typeof correctionStateSchema>;

/** One row of the log (BR-8): never deleted, it goes with its media. */
export const transcriptCorrectionSchema = z.object({
  id: z.uuid(),
  kind: correctionKindSchema,
  state: correctionStateSchema,
  version: z.number().int().min(1),
  /** The revision this row produced. */
  revision: z.number().int().min(0),
  position: z.number().int().min(0),
  count: z.number().int().min(1),
  segment: z.number().int().min(0),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  before: z.array(z.string()),
  after: z.string(),
  /** The correction an undo restored. */
  reverts: z.uuid().nullable(),
  carriedTo: z.uuid().nullable(),
  /** What a newer version said where a correction could not be carried (BR-9). */
  found: z.string().nullable(),
  groupId: z.uuid().nullable(),
  authorName: z.string().nullable(),
  /** Whether the person asking wrote it. */
  mine: z.boolean(),
  /** Whether the person asking may undo it now (BR-5). */
  canUndo: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type TranscriptCorrection = z.infer<typeof transcriptCorrectionSchema>;

/** A segment as a correction left it. */
export const rewrittenSegmentSchema = z.object({
  index: z.number().int().min(0),
  text: z.string(),
});
export type RewrittenSegment = z.infer<typeof rewrittenSegmentSchema>;

/** 201 to a correction or an undo; 200 with `correction: null` when nothing changed. */
export const transcriptCorrectionResultSchema = z.object({
  correction: transcriptCorrectionSchema.nullable(),
  version: z.number().int().min(1),
  revision: z.number().int().min(0),
  segments: z.array(rewrittenSegmentSchema),
});
export type TranscriptCorrectionResult = z.infer<
  typeof transcriptCorrectionResultSchema
>;

/** 201 to "Corrigir todas"; 200 for a retry with the same key. */
export const transcriptCorrectionBatchResultSchema = z.object({
  groupId: z.uuid(),
  count: z.number().int().min(0),
  version: z.number().int().min(1),
  revision: z.number().int().min(0),
  segments: z.array(rewrittenSegmentSchema),
});
export type TranscriptCorrectionBatchResult = z.infer<
  typeof transcriptCorrectionBatchResultSchema
>;

/** 200 to "Desfazer o grupo" (BR-14): what was undone and what had changed since. */
export const correctionGroupUndoResultSchema = z.object({
  undone: z.number().int().min(0),
  changed: z.number().int().min(0),
  version: z.number().int().min(1),
  revision: z.number().int().min(0),
  segments: z.array(rewrittenSegmentSchema),
});
export type CorrectionGroupUndoResult = z.infer<
  typeof correctionGroupUndoResultSchema
>;

/** One entry of the history: a correction alone, or a group's rows together (FR-13). */
export const correctionEntrySchema = z.object({
  groupId: z.uuid().nullable(),
  items: z.array(transcriptCorrectionSchema).min(1),
  /** A group the person may undo: every row theirs, or a master (BR-14). */
  canUndoGroup: z.boolean(),
});
export type CorrectionEntry = z.infer<typeof correctionEntrySchema>;

/** What happened to the corrections when the current version came (FR-8). */
export const correctionCarrySchema = z.object({
  version: z.number().int().min(1),
  carried: z.number().int().min(0),
  notCarried: z.number().int().min(0),
});
export type CorrectionCarry = z.infer<typeof correctionCarrySchema>;

/** GET …/transcript/corrections: newest first, a page at a time (FR-6). */
export const correctionHistoryQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).max(1_000_000).optional(),
});
export type CorrectionHistoryQuery = z.infer<
  typeof correctionHistoryQuerySchema
>;

export const correctionHistorySchema = z.object({
  mediaId: mediaIdSchema,
  /** Entries in the whole history. */
  total: z.number().int().min(0),
  entries: z.array(correctionEntrySchema),
  next: z.number().int().min(0).nullable(),
  carry: correctionCarrySchema.nullable(),
});
export type CorrectionHistory = z.infer<typeof correctionHistorySchema>;

/** GET …/transcript/occurrences: the preview of "Corrigir todas" (FR-12). */
export const occurrencesQuerySchema = z
  .object({
    text: z.string().min(1).max(2_000),
    /** A window (a track): occurrences whose first word starts in it are "Nesta faixa". */
    fromMs: z.coerce.number().int().min(0).max(100_000_000).optional(),
    toMs: z.coerce.number().int().min(0).max(100_000_000).optional(),
    /** `window`: only the window's occurrences are listed; `recording`: all. */
    scope: z.enum(['window', 'recording']).default('recording'),
  })
  .refine(
    (one) =>
      (one.fromMs === undefined) === (one.toMs === undefined) &&
      (one.fromMs === undefined || one.fromMs < (one.toMs ?? 0)),
    { error: 'a window has a start before its end' },
  );
export type OccurrencesQuery = z.infer<typeof occurrencesQuerySchema>;

export const occurrenceSchema = z.object({
  position: z.number().int().min(0),
  count: z.number().int().min(1),
  /** What its words say now: the batch sends it back as `expected`. */
  expected: z.array(z.string()),
  segment: z.number().int().min(0),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  /** The words before and after it in its segment, for the preview's context. */
  contextBefore: z.string(),
  text: z.string(),
  contextAfter: z.string(),
  inWindow: z.boolean(),
});
export type Occurrence = z.infer<typeof occurrenceSchema>;

export const occurrencesSchema = z.object({
  mediaId: mediaIdSchema,
  version: z.number().int().min(1),
  revision: z.number().int().min(0),
  /** Occurrences in the whole recording and in the window (0 without one). */
  total: z.number().int().min(0),
  inWindow: z.number().int().min(0),
  /** The first CORRECTION_MAX_BATCH of the scope, by time (BR-12). */
  occurrences: z.array(occurrenceSchema),
});
export type Occurrences = z.infer<typeof occurrencesSchema>;

/** Why a correction was refused with 409 (`details.reason`). */
export const correctionConflictReasonSchema = z.enum([
  'word-changed',
  'track-derived',
  'not-contiguous',
  'not-aligned',
  'changed-since',
]);
export type CorrectionConflictReason = z.infer<
  typeof correctionConflictReasonSchema
>;

/** The 409's `details`: what the words say now and who changed them (AC-12, AC-33). */
export const correctionConflictSchema = z.object({
  reason: correctionConflictReasonSchema,
  /** The words' texts now (one correction or undo). */
  current: z.array(z.string()).optional(),
  authorName: z.string().nullable().optional(),
  /** "Corrigir todas": the items whose words changed, by first position, with their text now. */
  changed: z
    .array(z.object({ position: z.number().int(), current: z.string() }))
    .optional(),
});
export type CorrectionConflict = z.infer<typeof correctionConflictSchema>;
