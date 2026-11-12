/**
 * Where each audio sample of an MP4 sits (KBC-106): its byte offset and size and its time,
 * from the sample table of the first sound track (stts, stsc, stsz, stco/co64, and the edit
 * list's start). Only the boxes are read, never the media data.
 */
export interface SampleIndex {
  readonly offsets: Float64Array;
  readonly sizes: Uint32Array;
  /** Presentation start of each sample, in ms. */
  readonly startsMs: Float64Array;
  /** Presentation end of each sample, in ms. */
  readonly endsMs: Float64Array;
}

/** Reads `length` bytes at `start` (fewer at the end of the file). */
export type ReadAt = (start: number, length: number) => Promise<Buffer>;

interface Box {
  readonly type: string;
  /** Where its content starts and ends, inside the buffer it was read from. */
  readonly start: number;
  readonly end: number;
}

/** The moov box is read whole: a larger one is not a file this can mask. */
const MAX_MOOV_BYTES = 64 * 1024 * 1024;

function boxesIn(buffer: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = buffer.readUInt32BE(at);
    const type = buffer.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      size = Number(buffer.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header || at + size > end) break;
    boxes.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return boxes;
}

const child = (buffer: Buffer, box: Box, type: string): Box | undefined =>
  boxesIn(buffer, box.start, box.end).find((one) => one.type === type);

function path(buffer: Buffer, from: Box, types: readonly string[]) {
  let box: Box | undefined = from;
  for (const type of types) box = box && child(buffer, box, type);
  return box;
}

/** The moov box, wherever it is in the file (faststart puts it first). */
async function readMoov(
  readAt: ReadAt,
  size: number,
): Promise<{ buffer: Buffer; box: Box } | null> {
  let at = 0;
  while (at + 8 <= size) {
    const head = await readAt(at, 16);
    if (head.length < 8) return null;
    let boxSize = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let header = 8;
    if (boxSize === 1 && head.length >= 16) {
      boxSize = Number(head.readBigUInt64BE(8));
      header = 16;
    } else if (boxSize === 0) boxSize = size - at;
    if (boxSize < header) return null;
    if (type === 'moov') {
      if (boxSize > MAX_MOOV_BYTES) return null;
      const buffer = await readAt(at, boxSize);
      if (buffer.length < boxSize) return null;
      return { buffer, box: { type, start: header, end: boxSize } };
    }
    at += boxSize;
  }
  return null;
}

/** The first track whose handler is sound, with its timescale and sample table. */
/**
 * The one track of the file, when it is sound (review M2, QA-5): a second track (sound or
 * picture) or fragments (`mvex`, samples in `moof`) would pass unmasked, so they are none.
 */
function soundTrack(buffer: Buffer, moov: Box) {
  const inside = boxesIn(buffer, moov.start, moov.end);
  const traks = inside.filter((one) => one.type === 'trak');
  const [trak] = traks;
  if (traks.length !== 1 || !trak || inside.some((one) => one.type === 'mvex'))
    return null;
  const mdia = child(buffer, trak, 'mdia');
  const hdlr = mdia && child(buffer, mdia, 'hdlr');
  if (!mdia || !hdlr) return null;
  if (buffer.toString('latin1', hdlr.start + 8, hdlr.start + 12) !== 'soun')
    return null;
  const mdhd = child(buffer, mdia, 'mdhd');
  const stbl = path(buffer, mdia, ['minf', 'stbl']);
  if (!mdhd || !stbl) return null;
  const version = buffer.readUInt8(mdhd.start);
  const timescale = buffer.readUInt32BE(mdhd.start + (version === 1 ? 20 : 12));
  return { trak, stbl, timescale };
}

/**
 * The media time the edit list starts at (the encoder's priming), or 0 without one. Only a
 * single edit that starts in the media is read; anything else (an empty edit first, several
 * edits) shifts the clock in ways the mask cannot follow: null.
 */
function mediaStart(buffer: Buffer, trak: Box): number | null {
  const elst = path(buffer, trak, ['edts', 'elst']);
  if (!elst) return 0;
  const version = buffer.readUInt8(elst.start);
  if (buffer.readUInt32BE(elst.start + 4) !== 1) return null;
  const entry = elst.start + 8;
  const time =
    version === 1
      ? Number(buffer.readBigInt64BE(entry + 8))
      : buffer.readInt32BE(entry + 4);
  return time >= 0 ? time : null;
}

/** How many samples the time table covers. */
function timedSamples(buffer: Buffer, stts: Box): number {
  const entries = buffer.readUInt32BE(stts.start + 4);
  let count = 0;
  for (let e = 0; e < entries; e++)
    count += buffer.readUInt32BE(stts.start + 8 + 8 * e);
  return count;
}

function sampleSizes(buffer: Buffer, stsz: Box): Uint32Array {
  const fixed = buffer.readUInt32BE(stsz.start + 4);
  const count = buffer.readUInt32BE(stsz.start + 8);
  const sizes = new Uint32Array(count);
  for (let i = 0; i < count; i++)
    sizes[i] =
      fixed !== 0 ? fixed : buffer.readUInt32BE(stsz.start + 12 + 4 * i);
  return sizes;
}

function chunkOffsets(buffer: Buffer, stbl: Box): Float64Array | null {
  const stco = child(buffer, stbl, 'stco');
  const co64 = child(buffer, stbl, 'co64');
  const box = stco ?? co64;
  if (!box) return null;
  const count = buffer.readUInt32BE(box.start + 4);
  const offsets = new Float64Array(count);
  for (let i = 0; i < count; i++)
    offsets[i] = stco
      ? buffer.readUInt32BE(box.start + 8 + 4 * i)
      : Number(buffer.readBigUInt64BE(box.start + 8 + 8 * i));
  return offsets;
}

/** How many samples each chunk holds: runs of chunks alike (stsc). */
function samplesPerChunk(
  buffer: Buffer,
  stsc: Box,
  chunkCount: number,
): Uint32Array {
  const entries = buffer.readUInt32BE(stsc.start + 4);
  const counts = new Uint32Array(chunkCount);
  for (let e = 0; e < entries; e++) {
    const at = stsc.start + 8 + 12 * e;
    const first = buffer.readUInt32BE(at) - 1;
    const next =
      e + 1 < entries ? buffer.readUInt32BE(at + 12) - 1 : chunkCount;
    counts.fill(buffer.readUInt32BE(at + 4), first, Math.min(next, chunkCount));
  }
  return counts;
}

/** Each sample's offset: a chunk holds consecutive samples from its own offset. */
function sampleOffsets(
  chunks: Float64Array,
  perChunk: Uint32Array,
  sizes: Uint32Array,
): Float64Array {
  const offsets = new Float64Array(sizes.length);
  let sample = 0;
  for (let chunk = 0; chunk < chunks.length; chunk++) {
    let offset = chunks[chunk] ?? 0;
    const last = Math.min(sizes.length, sample + (perChunk[chunk] ?? 0));
    for (; sample < last; sample++) {
      offsets[sample] = offset;
      offset += sizes[sample] ?? 0;
    }
  }
  return offsets;
}

/** Decoding times from stts, shifted by the edit list's start, in ms. */
function sampleTimes(
  buffer: Buffer,
  stts: Box,
  clock: {
    readonly timescale: number;
    readonly start: number;
    readonly count: number;
  },
) {
  const { count } = clock;
  const startsMs = new Float64Array(count);
  const endsMs = new Float64Array(count);
  const entries = buffer.readUInt32BE(stts.start + 4);
  let sample = 0;
  let time = 0;
  const toMs = (t: number) => ((t - clock.start) * 1000) / clock.timescale;
  for (let e = 0; e < entries && sample < count; e++) {
    const run = buffer.readUInt32BE(stts.start + 8 + 8 * e);
    const delta = buffer.readUInt32BE(stts.start + 12 + 8 * e);
    const last = Math.min(count, sample + run);
    for (; sample < last; sample++) {
      startsMs[sample] = toMs(time);
      time += delta;
      endsMs[sample] = toMs(time);
    }
  }
  return { startsMs, endsMs };
}

/** Every sample placed, and inside the file (none left at 0 by a short chunk table). */
function inFile(
  offsets: Float64Array,
  sizes: Uint32Array,
  fileSize: number,
): boolean {
  for (let i = 0; i < sizes.length; i++) {
    const offset = offsets[i] ?? 0;
    if (offset <= 0 || offset + (sizes[i] ?? 0) > fileSize) return false;
  }
  return true;
}

/** The sample index of an MP4's sound track; null when the file is not one this can read. */
export async function readSampleIndex(
  readAt: ReadAt,
  size: number,
): Promise<SampleIndex | null> {
  try {
    const moov = await readMoov(readAt, size);
    if (!moov) return null;
    const { buffer } = moov;
    const track = soundTrack(buffer, moov.box);
    if (!track || track.timescale === 0) return null;
    const stsz = child(buffer, track.stbl, 'stsz');
    const stsc = child(buffer, track.stbl, 'stsc');
    const stts = child(buffer, track.stbl, 'stts');
    const chunks = chunkOffsets(buffer, track.stbl);
    if (!stsz || !stsc || !stts || !chunks) return null;
    const sizes = sampleSizes(buffer, stsz);
    const start = mediaStart(buffer, track.trak);
    // Every sample timed, and some: a table the mask cannot vouch for is none.
    if (start === null || sizes.length === 0) return null;
    if (timedSamples(buffer, stts) !== sizes.length) return null;
    const perChunk = samplesPerChunk(buffer, stsc, chunks.length);
    const offsets = sampleOffsets(chunks, perChunk, sizes);
    if (!inFile(offsets, sizes, size)) return null;
    const clock = { timescale: track.timescale, start, count: sizes.length };
    return { offsets, sizes, ...sampleTimes(buffer, stts, clock) };
  } catch {
    // A box that lies about its size: not a file this can mask.
    return null;
  }
}
