/**
 * How many index candidates a search asks for when the viewer sees only part of a collection
 * (ADR 0036 §7): the plain budget divided by the visible share, never above the cap, and one
 * deeper call when the page comes back short while the index still had more.
 */
export const CANDIDATE_CAP = 1000;
/** The deeper call multiplies the limit by this, under the same cap. */
export const DEEPER_FACTOR = 4;

/** `min(1000, ceil(base / share))`; the share is already at least 0.05. */
export const candidateLimit = (base: number, share: number): number =>
  Math.min(CANDIDATE_CAP, Math.max(base, Math.ceil(base / share)));

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
