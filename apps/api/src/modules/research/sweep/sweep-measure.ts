import type {
  SweepCoverage,
  SweepCursor,
  SweepFinding,
  SweepStopReason,
  SweepTotals,
} from '@kb-chat/contracts';
import { coveredMark } from './sweep-cursor.js';
import type { SweepLayout } from './sweep-planner.js';

/** What a sweep has really finished, measured from its batches (never the model's word). */
export interface SweepMeasure {
  readonly totals: SweepTotals;
  /**
   * The documents covered: by earlier turns, or with every batch of theirs done (any
   * order, KBC-101): what the cursor marks and a continuation does not read again.
   */
  readonly covered: readonly string[];
  /** Documents the AI has to analyze, and of those, not analyzed yet. */
  readonly needed: number;
  readonly missing: number;
  /** The last id of the covered start of the set (the cursor before its mark, KBC-030). */
  readonly after?: string;
  /** The tracks of the set and of those analyzed (KBC-101 BR-2). */
  readonly tracks: { readonly documents: number; readonly read: number };
}

type Doc = SweepLayout['docs'][number];

/** Whether each document is covered: an earlier turn's, or each one of its batches done. */
function coveredFlags(
  layout: SweepLayout,
  done: readonly boolean[],
): boolean[] {
  const batchesOf = new Map<string, number[]>();
  for (const batch of layout.batches)
    for (const unit of batch.units) {
      const id = unit.entry.id;
      batchesOf.set(id, [...(batchesOf.get(id) ?? []), batch.index]);
    }
  return layout.docs.map(
    (doc, i) =>
      i < layout.skipped ||
      (batchesOf.get(doc.entry.id) ?? []).every((b) => done[b]),
  );
}

/**
 * The sweep's counts (KBC-030 design review): a document needs the AI when it has text to
 * read (with phrases: occurrences); it is analyzed once all of it is covered.
 */
export function measureSweep(
  layout: SweepLayout,
  {
    done,
    previousBatches,
  }: { done: readonly boolean[]; previousBatches: number },
): SweepMeasure {
  const flags = coveredFlags(layout, done);
  const covered = layout.docs.filter((_, i) => flags[i]);
  const withText = (doc: Doc) => doc.units.length > 0;
  const analyzed = covered.filter(withText);
  const { length: read } = analyzed;
  const { length: needed } = layout.docs.filter(withText);
  const totals: SweepTotals = {
    documents: layout.docs.length,
    scanned: layout.withHits === null ? read : layout.scanned,
    withHits: layout.withHits,
    read,
    batches: previousBatches + done.filter(Boolean).length,
  };
  return {
    totals,
    covered: covered.map((doc) => doc.entry.id),
    needed,
    missing: needed - read,
    after: afterOf(layout, flags),
    tracks: tracksAmong(layout.docs, analyzed),
  };
}

/** The last id of the covered start of the set: what a cursor before `covered` resumed after. */
function afterOf(
  layout: SweepLayout,
  flags: readonly boolean[],
): string | undefined {
  const start = flags.indexOf(false);
  return layout.docs[(start < 0 ? flags.length : start) - 1]?.entry.id;
}

/** The tracks of the set, and of those analyzed (KBC-101 BR-2). */
function tracksAmong(
  docs: SweepLayout['docs'],
  analyzed: SweepLayout['docs'],
): SweepMeasure['tracks'] {
  const isTrack = (doc: SweepLayout['docs'][number]) =>
    doc.entry.media !== null;
  return {
    documents: docs.filter(isTrack).length,
    read: analyzed.filter(isTrack).length,
  };
}

export interface Ending {
  readonly measure: SweepMeasure;
  readonly stopped: SweepStopReason | null;
  readonly findings: readonly SweepFinding[];
  readonly continued: boolean;
}

/** The coverage the turn reports. */
export function coverageOf(layout: SweepLayout, ending: Ending): SweepCoverage {
  const { measure, stopped, continued } = ending;
  const reason = measure.missing > 0 ? (stopped ?? 'stopped') : undefined;
  return {
    ...measure.totals,
    target: layout.plan.target,
    phrases: layout.plan.phrases,
    needed: measure.needed,
    missing: measure.missing,
    // Only a set with tracks names them (KBC-101 AC-5).
    ...(measure.tracks.documents > 0 && { tracks: measure.tracks }),
    ...(reason && { reason }),
    ...(continued && { continued: true }),
  };
}

/** Where a continuation resumes, with what was found; `findings` empty in progress events. */
export function cursorOf(
  layout: SweepLayout,
  { measure, findings }: Pick<Ending, 'measure' | 'findings'>,
): SweepCursor {
  const { after, totals, covered } = measure;
  return {
    plan: layout.plan,
    ...(after && { after }),
    covered: coveredMark(covered),
    totals,
    findings: [...findings],
  };
}
