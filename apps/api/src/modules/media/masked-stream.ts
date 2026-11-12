import { createHash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import type { HiddenSpan } from '@kb-chat/contracts';
import {
  readSampleIndex,
  type ReadAt,
  type SampleIndex,
} from './mp4-samples.js';
import { silentFrameOf } from './silent-aac.js';

/**
 * A recording's stream for someone who may not hear some of its tracks (KBC-106 FR-2): every
 * AAC frame that touches a hidden part is sent as a silent frame of the same size, so the file
 * stays playable and seekable while none of the hidden sound leaves the server. A range that
 * lies wholly inside a hidden part asks for nothing but hidden sound: 416.
 */

/** One hidden frame: where it is in the file. */
interface Frame {
  readonly offset: number;
  readonly size: number;
}

/** The frames to silence, by offset, and the byte runs they make. */
export interface MaskPlan {
  readonly frames: readonly Frame[];
  /** Contiguous runs of hidden frames, `end` exclusive. */
  readonly runs: readonly { readonly start: number; readonly end: number }[];
}

/** Every frame touching a hidden span (fail-closed: any overlap). */
export function maskPlanOf(
  index: SampleIndex,
  hidden: readonly HiddenSpan[],
): MaskPlan {
  const frames: Frame[] = [];
  const runs: { start: number; end: number }[] = [];
  for (let i = 0; i < index.sizes.length; i++) {
    const start = index.startsMs[i] ?? 0;
    const end = index.endsMs[i] ?? 0;
    if (!hidden.some((span) => start < span.endMs && end > span.startMs))
      continue;
    const offset = index.offsets[i] ?? 0;
    const size = index.sizes[i] ?? 0;
    frames.push({ offset, size });
    const last = runs.at(-1);
    if (last && last.end === offset) last.end = offset + size;
    else runs.push({ start: offset, end: offset + size });
  }
  frames.sort((a, b) => a.offset - b.offset);
  return { frames, runs };
}

/** `[start, end]` (inclusive) lies wholly inside hidden frames. */
export const insideHidden = (
  plan: MaskPlan,
  range: { readonly start: number; readonly end: number },
): boolean =>
  plan.runs.some((run) => range.start >= run.start && range.end < run.end);

/** First frame that ends after `position` (binary search). */
function firstFrameFrom(frames: readonly Frame[], position: number): number {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const frame = frames[middle];
    if (frame && frame.offset + frame.size <= position) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Silences, in `out` (the bytes from `position`), the parts of the frames from `next` on that
 * it holds; the first frame not finished in it, to start from with the next chunk.
 */
function silenceIn(
  out: Buffer,
  at: {
    readonly frames: readonly Frame[];
    readonly position: number;
    readonly next: number;
  },
): number {
  const { frames, position } = at;
  const end = position + out.length;
  let next = at.next;
  for (let i = at.next; i < frames.length; i++) {
    const frame = frames[i];
    if (!frame || frame.offset >= end) break;
    const from = Math.max(frame.offset, position);
    const to = Math.min(frame.offset + frame.size, end);
    silentFrameOf(frame.size).copy(
      out,
      from - position,
      from - frame.offset,
      to - frame.offset,
    );
    if (frame.offset + frame.size <= end) next = i + 1;
  }
  return next;
}

/** The bytes from `start` on, with the hidden frames' bytes replaced by silence. */
export function maskedStream(
  source: Readable,
  plan: MaskPlan,
  start: number,
): Readable {
  let position = start;
  let next = firstFrameFrom(plan.frames, start);
  const mask = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      const out = Buffer.from(chunk);
      next = silenceIn(out, { frames: plan.frames, position, next });
      position += out.length;
      done(null, out);
    },
  });
  source.on('error', (err) => mask.destroy(err));
  return source.pipe(mask);
}

/** Changes with the set of hidden spans: a masked file is another entity than the whole one. */
export const hiddenTagOf = (hidden: readonly HiddenSpan[]): string =>
  createHash('sha256')
    .update(hidden.map((one) => `${one.startMs}-${one.endMs}`).join(','))
    .digest('hex')
    .slice(0, 12);

interface Cached {
  readonly key: string;
  readonly index: SampleIndex | null;
}

const CACHE_SIZE = 4;

/** Sample indexes of the files played most recently: a 2 h file is ~6 MB of tables. */
export class SampleIndexCache {
  private readonly kept: Cached[] = [];

  async indexOf(
    file: {
      readonly path: string;
      readonly size: number;
      readonly modifiedMs: number;
    },
    readAt: ReadAt,
  ): Promise<SampleIndex | null> {
    const key = `${file.path}:${file.size}:${file.modifiedMs}`;
    const found = this.kept.find((one) => one.key === key);
    if (found) return found.index;
    const index = await readSampleIndex(readAt, file.size);
    this.kept.unshift({ key, index });
    if (this.kept.length > CACHE_SIZE) this.kept.pop();
    return index;
  }
}

/** Reads `length` bytes at `start` from a range opener. */
export const readAtOf =
  (
    open: (range: { start: number; end: number }) => Readable,
    size: number,
  ): ReadAt =>
  async (start, length) => {
    const end = Math.min(size, start + length) - 1;
    if (end < start) return Buffer.alloc(0);
    const parts: Buffer[] = [];
    for await (const part of open({ start, end }))
      parts.push(Buffer.from(part as Buffer));
    return Buffer.concat(parts);
  };
