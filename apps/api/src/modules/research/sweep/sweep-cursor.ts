import { createHash } from 'node:crypto';
import { MAX_COVERED_DOCUMENTS } from '@kb-chat/contracts';
import type { CatalogEntry } from '../../catalog/index.js';

/** Where a continuation resumes: the cursor's last id and, since KBC-101, its covered mark. */
export interface CursorMark {
  readonly after?: string;
  readonly covered?: string;
}

const HASH_BYTES = 4;

/** A document id as 4 bytes: what a cursor keeps of each covered document. */
const idHash = (id: string): number =>
  createHash('sha256').update(id).digest().readUInt32BE(0);

/**
 * The documents a sweep covered, as a cursor carries them (code review 2 of KBC-101): the
 * sorted 4-byte hashes of their ids, base64. Past `MAX_COVERED_DOCUMENTS` the rest are left
 * out and a continuation reads them again.
 */
export function coveredMark(ids: readonly string[]): string {
  const hashes = [
    ...new Set(ids.slice(0, MAX_COVERED_DOCUMENTS).map(idHash)),
  ].sort((a, b) => a - b);
  const bytes = Buffer.alloc(hashes.length * HASH_BYTES);
  hashes.forEach((hash, i) => bytes.writeUInt32BE(hash, i * HASH_BYTES));
  return bytes.toString('base64');
}

function hashesOf(covered: string): ReadonlySet<number> {
  const bytes = Buffer.from(covered, 'base64');
  const out = new Set<number>();
  for (let at = 0; at + HASH_BYTES <= bytes.length; at += HASH_BYTES)
    out.add(bytes.readUInt32BE(at));
  return out;
}

/**
 * Which documents of the set a cursor already covered. With the mark, exactly those it
 * names: a document that joined the set since (a track the transcriber published, a new
 * text) is read wherever its id sorts, and none is read twice. A cursor from before the
 * mark (KBC-030) covered the collection's own texts up to its id, in id order: tracks and
 * sub-collections' documents were not in its set yet.
 */
export function coveredBy({
  after,
  covered,
}: CursorMark): (entry: CatalogEntry) => boolean {
  if (covered !== undefined) {
    const hashes = hashesOf(covered);
    return (entry) => hashes.has(idHash(entry.id));
  }
  if (after === undefined) return () => false;
  return (entry) => !entry.home && entry.media === null && entry.id <= after;
}
