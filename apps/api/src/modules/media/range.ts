/**
 * HTTP Range for the media stream (RFC 9110 §14; ADR 0022 §5). The player asks for byte
 * ranges to start fast and to seek; Safari on iPhone refuses media without them.
 */
export type RangeAnswer =
  | { readonly kind: 'full' }
  | { readonly kind: 'partial'; readonly start: number; readonly end: number }
  | { readonly kind: 'unsatisfiable' };

const FULL: RangeAnswer = { kind: 'full' };
const UNSATISFIABLE: RangeAnswer = { kind: 'unsatisfiable' };
const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * What to send for a `Range` header on a file of `size` bytes. A missing, malformed or
 * multi-range header gets the whole file (a server may ignore Range); `end` is inclusive.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): RangeAnswer {
  const match = header?.trim().match(SINGLE_RANGE);
  if (!match) return FULL;
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return FULL;
  if (first === '') return suffixRange(Number(last), size);
  const start = Number(first);
  if (last !== '' && Number(last) < start) return FULL;
  if (start >= size) return UNSATISFIABLE;
  const end = last === '' ? size - 1 : Number(last);
  return { kind: 'partial', start, end: Math.min(end, size - 1) };
}

/** `bytes=-n`: the last n bytes. */
function suffixRange(length: number, size: number): RangeAnswer {
  if (length === 0 || size === 0) return UNSATISFIABLE;
  return { kind: 'partial', start: Math.max(0, size - length), end: size - 1 };
}

/**
 * `If-Range` with a stale validator means "the file changed: send it whole". Only strong
 * entity tags are compared (a date or weak tag never matches).
 */
export function rangeStillValid(
  ifRange: string | undefined,
  etag: string,
): boolean {
  return ifRange === undefined || ifRange.trim() === etag;
}

/** A strong entity tag of a stored file: changes when the file is replaced. */
export const entityTagOf = (
  id: string,
  file: { readonly size: number; readonly modifiedMs: number },
): string => `"${id}-${file.size}-${Math.trunc(file.modifiedMs)}"`;
