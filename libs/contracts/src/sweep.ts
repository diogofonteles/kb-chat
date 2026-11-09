import { z } from 'zod';
import { authorshipSchema } from './facets.js';

/**
 * The exhaustive profile's app-driven sweep (KBC-030, ADR 0021): the orchestrator plans a
 * target set, the app reads all of it in batches and computes the coverage itself.
 */

/** Which documents of the topic a sweep covers; no field: the whole topic. */
export const sweepTargetSchema = z.strictObject({
  authorship: authorshipSchema.optional(),
  /** A fragment of one of the document's kb entities (author, person, work). */
  entity: z.string().trim().min(2).max(120).optional(),
  /** A fragment of the document's source_path (its origin folder). */
  source: z.string().trim().min(2).max(200).optional(),
  subjects: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
});
export type SweepTarget = z.infer<typeof sweepTargetSchema>;

/** Expressions a sweep looks for first; documents without any are scanned, not read. */
export const MAX_SWEEP_PHRASES = 12;

export const sweepPlanSchema = z.strictObject({
  target: sweepTargetSchema,
  phrases: z
    .array(z.string().trim().min(3).max(80))
    .max(MAX_SWEEP_PHRASES)
    .default([]),
  /** What each batch must extract ("livros citados de forma positiva, com trecho"). */
  extract: z.string().trim().min(3).max(1000),
});
export type SweepPlan = z.infer<typeof sweepPlanSchema>;

const count = z.number().int().nonnegative();

/**
 * What a sweep covered so far, cumulative across continuations: the set's documents,
 * those examined inside (pattern-scanned or read whole), those with occurrences of the
 * phrases (null without phrases) and those a model read.
 */
export const sweepTotalsSchema = z
  .strictObject({
    documents: count,
    scanned: count,
    withHits: count.nullable(),
    read: count,
    batches: count,
  })
  .refine(
    (t) =>
      t.scanned <= t.documents &&
      t.read <= t.documents &&
      (t.withHits ?? 0) <= t.documents,
    { error: 'totals count more than the set' },
  );
export type SweepTotals = z.infer<typeof sweepTotalsSchema>;

/**
 * One finding carried from a sweep turn to its continuation: the document's id and the
 * text, so "Continuar varredura" answers with what earlier turns found too (KBC-030 QA F-1).
 */
export const sweepFindingSchema = z.strictObject({
  id: z.string().min(1).max(300),
  text: z.string().min(1).max(300),
});
export type SweepFinding = z.infer<typeof sweepFindingSchema>;

/**
 * Documents a cursor marks as covered at most: 4 bytes each, so the mark stays near 107 KB
 * of base64 and a continuation's request well under 1 MB with its findings.
 */
export const MAX_COVERED_DOCUMENTS = 20_000;
const MAX_COVERED_CHARS = Math.ceil((MAX_COVERED_DOCUMENTS * 4) / 3) + 4;

/** Findings a cursor carries at most (keeps a continuation's request well under 1 MB). */
export const MAX_CARRIED_FINDINGS = 600;
/** New findings one progress event carries at most. */
export const MAX_FOUND_PER_PROGRESS = 200;

/**
 * Where an unfinished sweep stopped: its plan and the last document id fully swept, in id
 * order (absent: none). "Continuar varredura" sends it back (`sweep` in the request).
 */
export const sweepCursorSchema = z.strictObject({
  plan: sweepPlanSchema,
  after: z.string().min(1).max(1000).optional(),
  /**
   * The documents swept so far, by this turn and the ones it continues (KBC-101): hashes of
   * their ids, base64. A continuation reads every other document of the set, so one that
   * joined it since is read and none is read twice. Absent on cursors from before it: they
   * resume after `after`, in id order.
   */
  covered: z
    .string()
    .max(MAX_COVERED_CHARS)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .optional(),
  totals: sweepTotalsSchema,
  /** What the sweep found so far, merged into the continuation's answer. */
  findings: z.array(sweepFindingSchema).max(MAX_CARRIED_FINDINGS).default([]),
});
export type SweepCursor = z.infer<typeof sweepCursorSchema>;

/** Why a sweep ended before covering its whole set. */
export const SWEEP_STOP_REASONS = [
  /** The exhaustive profile's wall-clock ceiling. */
  'time',
  /** The turn's request budget (server cap, the house's free requests). */
  'requests',
  /** The person's daily spend cap. */
  'spend',
  /** The provider kept refusing (rate limits) after the waits. */
  'capacity',
  /** The reader pressed "Parar". */
  'stopped',
] as const;
export const sweepStopReasonSchema = z.enum(SWEEP_STOP_REASONS);
export type SweepStopReason = z.infer<typeof sweepStopReasonSchema>;

/** The coverage of a sweep turn, computed by the app (never written by the model). */
export const sweepCoverageSchema = z
  .strictObject({
    target: sweepTargetSchema,
    phrases: z.array(z.string()).max(MAX_SWEEP_PHRASES),
    documents: count,
    scanned: count,
    withHits: count.nullable(),
    read: count,
    /**
     * Documents the AI has to analyze: those with occurrences of the phrases, or with
     * phrases absent every document with text (KBC-030 design review).
     */
    needed: count,
    /** Of those, not analyzed yet (a continuation analyzes them). */
    missing: count,
    batches: count,
    /**
     * The tracks among them (KBC-101 BR-2): of the set, and of those the AI analyzed.
     * Absent when the set has none (nothing says "faixas" then, AC-5).
     */
    tracks: z.strictObject({ documents: count, read: count }).optional(),
    reason: sweepStopReasonSchema.optional(),
    /** The counts include earlier turns of the same sweep ("Continuar varredura"). */
    continued: z.boolean().optional(),
  })
  .refine(
    (c) =>
      c.scanned <= c.documents &&
      c.read <= c.needed &&
      c.needed <= c.documents &&
      c.missing <= c.needed &&
      (c.withHits ?? 0) <= c.documents,
    { error: 'coverage counts more than the set' },
  );
export type SweepCoverage = z.infer<typeof sweepCoverageSchema>;

/** The estimate before the first batch, then the progress after each one. */
export const sweepProgressSchema = z.strictObject({
  status: z.enum(['planned', 'running']),
  documents: count,
  /** Documents the AI has to analyze (see the coverage's `needed`). */
  needed: count,
  /** Of those, analyzed so far, previous continuations included. */
  documentsDone: count,
  batches: count,
  batchesDone: count,
  /** Model requests the sweep is expected to make (batches, planning, final answer). */
  requests: count,
  /** Free models: slower and less rigorous; the estimate says so. */
  free: z.boolean(),
  /** At least this many minutes (free models are paced), when known. */
  minutes: count.optional(),
  /** At most this much in US$ on a per-token model, when known. */
  usd: z.number().nonnegative().optional(),
  /** Where to continue from if the turn stops now (its findings come apart, in `found`). */
  cursor: sweepCursorSchema.optional(),
  /** The findings of the batch that just finished: the page keeps them for a stop. */
  found: z.array(sweepFindingSchema).max(MAX_FOUND_PER_PROGRESS).optional(),
});
export type SweepProgress = z.infer<typeof sweepProgressSchema>;

/**
 * How a continuation's question is stored and shown (data, like every question): the label,
 * then what the reader first asked. The model always gets the question without it.
 */
export const SWEEP_CONTINUATION_LABEL = 'Continuar varredura: ';

/** A question without the continuation's label. */
export const originalSweepQuestion = (question: string): string =>
  question.startsWith(SWEEP_CONTINUATION_LABEL)
    ? question.slice(SWEEP_CONTINUATION_LABEL.length)
    : question;

/** The question of a continuation, as the history keeps it. */
export const continuationQuestion = (question: string): string =>
  `${SWEEP_CONTINUATION_LABEL}${originalSweepQuestion(question)}`.slice(
    0,
    2000,
  );

/**
 * Findings merged in order without repeats (same document and text), at most the cap: the
 * page and the server build a cursor the same way, also when a turn is followed again and
 * its batches come a second time.
 */
export function mergeFindings(
  ...lists: readonly (readonly SweepFinding[])[]
): SweepFinding[] {
  const byKey = new Map<string, SweepFinding>();
  for (const finding of lists.flat())
    byKey.set(`${finding.id}\u0000${finding.text}`, finding);
  return [...byKey.values()].slice(0, MAX_CARRIED_FINDINGS);
}
