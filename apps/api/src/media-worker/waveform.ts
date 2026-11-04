import type { FfmpegBins } from './ffmpeg.js';
import { runProcess } from './process-runner.js';

/** Mono 16-bit samples per second: speech peaks need no more, and it decodes fast. */
const SAMPLE_RATE = 8_000;
const BYTES_PER_SAMPLE = 2;
const FULL_SCALE = 32_768;

/** The audio as raw mono samples on stdout. */
export const waveformArgs = (source: string) => [
  '-hide_banner',
  '-nostdin',
  '-loglevel',
  'error',
  '-i',
  source,
  '-vn',
  '-sn',
  '-dn',
  '-ac',
  '1',
  '-ar',
  String(SAMPLE_RATE),
  '-f',
  's16le',
  'pipe:1',
];

/**
 * Keeps the loudest sample of each window as one byte (0 is silence, 255 is full scale).
 * Chunks may end in the middle of a sample; the leftover byte goes with the next one.
 */
export class PeakMeter {
  private readonly peaks: number[] = [];
  private readonly samplesPerPeak: number;
  private loudest = 0;
  private counted = 0;
  private leftover: Buffer | null = null;

  constructor(peaksPerSecond: number) {
    this.samplesPerPeak = Math.round(SAMPLE_RATE / peaksPerSecond);
  }

  read(chunk: Buffer): void {
    const bytes = this.leftover ? Buffer.concat([this.leftover, chunk]) : chunk;
    const whole = bytes.length - (bytes.length % BYTES_PER_SAMPLE);
    for (let at = 0; at < whole; at += BYTES_PER_SAMPLE)
      this.add(Math.abs(bytes.readInt16LE(at)));
    this.leftover = whole < bytes.length ? bytes.subarray(whole) : null;
  }

  private add(level: number): void {
    this.loudest = Math.max(this.loudest, level);
    this.counted += 1;
    if (this.counted === this.samplesPerPeak) this.flush();
  }

  private flush(): void {
    this.peaks.push(Math.round((this.loudest / FULL_SCALE) * 255));
    this.loudest = 0;
    this.counted = 0;
  }

  /** Every peak, the last window however short it is. */
  result(): Buffer {
    if (this.counted > 0) this.flush();
    return Buffer.from(this.peaks);
  }
}

/** Measures the peaks of `source`; NFR-2: ≤ 20 s per hour of audio on the worker. */
export async function measurePeaks(input: {
  readonly bins: FfmpegBins;
  readonly source: string;
  readonly peaksPerSecond: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<Buffer> {
  const meter = new PeakMeter(input.peaksPerSecond);
  const result = await runProcess(
    input.bins.ffmpeg,
    waveformArgs(input.source),
    {
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      onData: (chunk) => meter.read(chunk),
    },
  );
  if (result.aborted) throw new Error('waveform aborted');
  if (result.timedOut)
    throw new Error(`waveform timed out after ${input.timeoutMs} ms`);
  if (result.code !== 0)
    throw new Error(
      `ffmpeg exited with ${result.code}: ${result.stderrTail.trim()}`,
    );
  return meter.result();
}
