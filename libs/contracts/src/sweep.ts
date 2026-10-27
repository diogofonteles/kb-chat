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
 * Where an unfinished sweep stopped: its plan and the last document id fully swept, in id
 * order (absent: none). "Continuar varredura" sends it back (`sweep` in the request).
 */
export const sweepCursorSchema = z.strictObject({
  plan: sweepPlanSchema,
  after: z.string().min(1).max(1000).optional(),
  totals: sweepTotalsSchema,
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
    /** Documents of the set not covered yet (a continuation covers them). */
    missing: count,
    batches: count,
    reason: sweepStopReasonSchema.optional(),
  })
  .refine(
    (c) =>
      c.scanned <= c.documents &&
      c.read <= c.documents &&
      c.missing <= c.documents &&
      (c.withHits ?? 0) <= c.documents,
    { error: 'coverage counts more than the set' },
  );
export type SweepCoverage = z.infer<typeof sweepCoverageSchema>;

/** The estimate before the first batch, then the progress after each one. */
export const sweepProgressSchema = z.strictObject({
  status: z.enum(['planned', 'running']),
  documents: count,
  /** Documents fully swept, previous continuations included. */
  documentsDone: count,
  batches: count,
  batchesDone: count,
  /** Model requests the sweep is expected to make (batches, planning, final answer). */
  requests: count,
  /** Free models: slower and less rigorous; the estimate says so. */
  free: z.boolean(),
  /** Where to continue from if the turn stops now. */
  cursor: sweepCursorSchema.optional(),
});
export type SweepProgress = z.infer<typeof sweepProgressSchema>;
