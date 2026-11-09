import type {
  SweepCoverage,
  SweepCursor,
  SweepFinding,
  SweepStopReason,
  SweepTotals,
} from '@kb-chat/contracts';
import type { SweepLayout } from './sweep-planner.js';

/** What a sweep has really finished, measured from its batches (never the model's word). */
export interface SweepMeasure {
  readonly totals: SweepTotals;
  /** Documents covered from the start of the set, in id order (the cursor's prefix). */
  readonly swept: number;
  /** Documents the AI has to analyze, and of those, not analyzed yet. */
  readonly needed: number;
  readonly missing: number;
  readonly after?: string;
  /** The tracks of the set and of those analyzed (KBC-101 BR-2). */
  readonly tracks: { readonly documents: number; readonly read: number };
}

/** The documents covered from the start of the set: each one's batches all done. */
function prefixOf(layout: SweepLayout, done: readonly boolean[]): number {
  const batchesOf = new Map<string, number[]>();
  for (const batch of layout.batches)
    for (const unit of batch.units) {
      const id = unit.entry.id;
      batchesOf.set(id, [...(batchesOf.get(id) ?? []), batch.index]);
    }
  let count = layout.skipped;
  while (count < layout.docs.length) {
    const id = layout.docs[count]?.entry.id ?? '';
    if (!(batchesOf.get(id) ?? []).every((i) => done[i])) break;
    count += 1;
  }
  return count;
}

/**
 * The sweep's counts (KBC-030 design review): a document needs the AI when it has text to
 * read (with phrases: occurrences); it is analyzed once it lies in the covered prefix.
 */
export function measureSweep(
  layout: SweepLayout,
  {
    done,
    previousBatches,
  }: { done: readonly boolean[]; previousBatches: number },
): SweepMeasure {
  const swept = prefixOf(layout, done);
  const withText = (doc: SweepLayout['docs'][number]) => doc.units.length > 0;
  const analyzed = layout.docs.slice(0, swept).filter(withText);
  const { length: read } = analyzed;
  const { length: needed } = layout.docs.filter(withText);
  const totals: SweepTotals = {
    documents: layout.docs.length,
    scanned: layout.withHits === null ? read : layout.scanned,
    withHits: layout.withHits,
    read,
    batches: previousBatches + done.filter(Boolean).length,
  };
  const after = layout.docs[swept - 1]?.entry.id;
  const tracks = tracksAmong(layout.docs, analyzed);
  return { totals, swept, needed, missing: needed - read, after, tracks };
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
  const { after, totals } = measure;
  return {
    plan: layout.plan,
    ...(after && { after }),
    totals,
    findings: [...findings],
  };
}
