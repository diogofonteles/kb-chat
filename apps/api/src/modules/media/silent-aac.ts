/**
 * One AAC-LC raw data block of exactly `size` bytes that decodes to silence (KBC-106): a single
 * channel element with no spectral data, padded with fill elements, then the end element.
 * Swapped for a hidden frame, the file stays valid for every decoder and its sample table
 * (offsets and sizes) does not change, so a browser plays and seeks as before.
 */
const SCE_BITS = 29;
const END_BITS = 3;
const FILL_MAX = 269;

/** Bits a fill element with `count` payload bytes takes. */
const fillBits = (count: number): number =>
  count < 15 ? 7 + 8 * count : 15 + 8 * count;

class BitWriter {
  private bit = 0;
  constructor(private readonly out: Buffer) {}

  write(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      if ((value >> i) & 1) {
        const at = this.bit >> 3;
        this.out[at] = (this.out[at] ?? 0) | (0x80 >> (this.bit & 7));
      }
      this.bit++;
    }
  }
}

function writeFill(writer: BitWriter, count: number): void {
  writer.write(6, 3); // ID_FIL
  if (count < 15) writer.write(count, 4);
  else {
    writer.write(15, 4);
    writer.write(count - 14, 8);
  }
  // extension_payload: EXT_FILL with its nibble, then fill bytes (0b10100101).
  for (let i = 0; i < count; i++) writer.write(i === 0 ? 0 : 0xa5, 8);
}

/** The fill element that closes `budget` bits, give or take the last byte's padding. */
function closingFill(budget: number): number | null {
  for (let count = 0; count <= FILL_MAX; count++) {
    const bits = fillBits(count);
    if (bits <= budget && bits >= budget - 7) return count;
  }
  return null;
}

export function silentAacFrame(size: number): Buffer {
  const out = Buffer.alloc(size);
  // Smaller than the shortest valid block: zeros (never seen in a real AAC stream).
  if (size * 8 < SCE_BITS + END_BITS) return out;
  const writer = new BitWriter(out);
  writer.write(0, 3); // ID_SCE
  writer.write(0, 4); // element_instance_tag
  writer.write(100, 8); // global_gain
  writer.write(0, 1); // ics_reserved_bit
  writer.write(0, 2); // window_sequence: ONLY_LONG
  writer.write(0, 1); // window_shape
  writer.write(0, 6); // max_sfb: no bands, so no section, scale factor or spectral data
  writer.write(0, 1); // predictor_data_present
  writer.write(0, 1); // pulse_data_present
  writer.write(0, 1); // tns_data_present
  writer.write(0, 1); // gain_control_data_present
  let budget = size * 8 - SCE_BITS - END_BITS;
  while (budget > 0) {
    const last = closingFill(budget);
    if (last !== null) {
      writeFill(writer, last);
      break;
    }
    writeFill(writer, FILL_MAX);
    budget -= fillBits(FILL_MAX);
  }
  writer.write(7, 3); // ID_END
  return out;
}

const frames = new Map<number, Buffer>();

/** The silent frame of `size`, made once per size. */
export function silentFrameOf(size: number): Buffer {
  let frame = frames.get(size);
  if (!frame) {
    frame = silentAacFrame(size);
    if (frames.size < 4096) frames.set(size, frame);
  }
  return frame;
}
