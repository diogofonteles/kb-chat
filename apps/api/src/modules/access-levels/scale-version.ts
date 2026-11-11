import { createHash } from 'node:crypto';
import type { StoredLevel } from './level-directory.js';

/**
 * A scale's version (KBC-108 FR-5, BR-3): a digest of its levels in order, so every write of
 * the scale (create, rename, reorder, delete) changes it, with no new field in
 * `access-levels.json` (an image rolled back still reads that file's strict schema). A scale
 * written back exactly as it was has its old version again, and a preview of it holds again.
 */
export function scaleVersion(scale: readonly StoredLevel[]): string {
  const levels = scale.map(({ id, code, description }) => [
    id,
    code,
    description,
  ]);
  return createHash('sha256')
    .update(JSON.stringify(levels))
    .digest('hex')
    .slice(0, 16);
}
