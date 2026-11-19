/**
 * How many index candidates a search asks for when the viewer sees only part of a collection
 * (ADR 0036 §7): the plain budget divided by the visible share, with headroom, never above the
 * cap, and one deeper call when the page comes back short while the index still had more.
 */
export const CANDIDATE_CAP = 1000;
/** The deeper call multiplies the limit by this, under the same cap. */
export const DEEPER_FACTOR = 4;
/**
 * `base / share` aims at exactly `base` visible hits, so about half the searches came back
 * short and paid the deeper call (KBC-111 recall.md); half as much again makes it rare
 * (KBC-120 AC-2).
 */
export const HEADROOM = 1.5;

/**
 * How deep each sub-search ranks in the hybrid mode for whoever sees a whole collection
 * (KBC-120): QMD's default of 20 per sub-search fuses a different top 10 than the fusion over
 * every text (recall@10 0.825). Measured on the patched QMD (work/KBC-120/recall.md): 60 gives
 * 0.895, 100 exactly 0.950 (no margin), 150 0.985 for about 5 ms more, all far below the 250 ms
 * p95 ceiling. Exact and semantic keep the index's own depth: their pages already match.
 */
export const WHOLE_VIEW_HYBRID_DEPTH = 150;

/** `min(1000, ceil(base / share × 1.5))`; the share is already at least 0.05. */
export const candidateLimit = (base: number, share: number): number =>
  Math.min(CANDIDATE_CAP, Math.max(base, Math.ceil((base / share) * HEADROOM)));

export const deeperLimit = (limit: number): number =>
  Math.min(CANDIDATE_CAP, limit * DEEPER_FACTOR);

/** A short page while the index returned its whole limit, with room to go deeper. */
export const needsDeeper = (page: {
  readonly visible: number;
  readonly base: number;
  readonly indexFull: boolean;
  readonly limit: number;
}): boolean =>
  page.visible < page.base && page.indexFull && page.limit < CANDIDATE_CAP;
