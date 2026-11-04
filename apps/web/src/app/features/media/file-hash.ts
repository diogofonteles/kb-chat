import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  type Observable,
  concat,
  concatMap,
  defer,
  distinctUntilChanged,
  from,
  map,
  of,
} from 'rxjs';

/** Read a slice at a time: a 4 GB file never sits in memory, and the screen keeps moving. */
const SLICE_BYTES = 1024 ** 2;

export type HashEvent =
  | { readonly kind: 'progress'; readonly percent: number }
  | { readonly kind: 'done'; readonly sha256: string };

const sliceStarts = (size: number): number[] =>
  Array.from({ length: Math.ceil(size / SLICE_BYTES) }, (_, i) => i * SLICE_BYTES);

/**
 * The file's SHA-256, computed in the browser (KBC-035 FR-1). In JavaScript on purpose: Web
 * Crypto cannot hash in parts, and WebAssembly would need a looser Content-Security-Policy.
 */
export function hashFile(file: Blob): Observable<HashEvent> {
  return defer(() => {
    const hash = sha256.create();
    const read = from(sliceStarts(file.size)).pipe(
      concatMap((start) =>
        from(file.slice(start, start + SLICE_BYTES).arrayBuffer()).pipe(
          map((bytes) => {
            hash.update(new Uint8Array(bytes));
            return Math.floor(((start + bytes.byteLength) / file.size) * 100);
          }),
        ),
      ),
      distinctUntilChanged(),
      map((percent): HashEvent => ({ kind: 'progress', percent })),
    );
    const done = defer(() =>
      of<HashEvent>({ kind: 'done', sha256: bytesToHex(hash.digest()) }),
    );
    return concat(read, done);
  });
}
