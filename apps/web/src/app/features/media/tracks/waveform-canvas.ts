/** One bar of the wave per this many CSS pixels, 3 px wide with rounded ends (v2 frames). */
const BAR_PX = 5;
const BAR_WIDTH_PX = 3;

export interface PeakWindow {
  readonly peaks: Uint8Array;
  readonly peaksPerSecond: number;
  readonly startMs: number;
  readonly spanMs: number;
}

/** The loudest peak of `[from, to)`, 0 to 1, read as loudness (a square root lifts speech). */
export function barHeight(
  peaks: Uint8Array,
  range: { readonly from: number; readonly to: number },
): number {
  let loudest = 0;
  const end = Math.min(peaks.length, Math.max(range.to, range.from + 1));
  for (let index = Math.max(0, range.from); index < end; index += 1)
    loudest = Math.max(loudest, peaks[index] ?? 0);
  return Math.sqrt(loudest / 255);
}

/** Draws the wave of a window on a canvas sized to the element, in the theme's color. */
export function drawPeaks(canvas: HTMLCanvasElement, input: PeakWindow): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  const ratio = globalThis.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  context.scale(ratio, ratio);
  context.fillStyle = getComputedStyle(canvas).color;
  const bars = Math.floor(width / BAR_PX);
  const peaksPerMs = input.peaksPerSecond / 1000;
  const peaksPerBar = (input.spanMs * peaksPerMs) / (bars || 1);
  const firstPeak = input.startMs * peaksPerMs;
  for (let bar = 0; bar < bars; bar += 1) {
    const from = Math.floor(firstPeak + bar * peaksPerBar);
    const to = Math.floor(firstPeak + (bar + 1) * peaksPerBar);
    const barH = Math.max(4, barHeight(input.peaks, { from, to }) * height);
    const x = bar * BAR_PX;
    const y = (height - barH) / 2;
    if (typeof context.roundRect === 'function') {
      context.beginPath();
      context.roundRect(x, y, BAR_WIDTH_PX, barH, 1);
      context.fill();
    } else context.fillRect(x, y, BAR_WIDTH_PX, barH);
  }
}

/** The peaks as they arrive: base64, one byte each (KBC-066). */
export const decodePeaks = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
