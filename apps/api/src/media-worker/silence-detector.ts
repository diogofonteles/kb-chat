import type { SilenceInterval } from '@kb-chat/contracts';
import type { FfmpegBins } from './ffmpeg.js';
import { runProcess } from './process-runner.js';

/** The detector's parameters, as the job names them (KBC-044 FR-1). */
export interface SilenceDetectorInput {
  readonly noiseDb: number;
  readonly minSilenceMs: number;
}

const START = /silence_start:\s*(-?[\d.]+)/;
const END = /silence_end:\s*(-?[\d.]+)/;

const toMs = (seconds: string): number =>
  Math.max(0, Math.round(Number(seconds) * 1000));

/**
 * Reads ffmpeg's `silencedetect` report line by line: each `silence_start` opens a pause
 * and the next `silence_end` closes it. A pause still open when the file ends (an older
 * ffmpeg reports no end then) lasts to `durationMs`, when known.
 */
export class SilenceReport {
  private openAt: number | null = null;
  private readonly found: SilenceInterval[] = [];

  read(line: string): void {
    const start = START.exec(line);
    if (start?.[1] !== undefined) {
      this.openAt = toMs(start[1]);
      return;
    }
    const end = END.exec(line);
    if (end?.[1] === undefined || this.openAt === null) return;
    this.close(toMs(end[1]));
  }

  intervals(durationMs: number | null): SilenceInterval[] {
    if (this.openAt !== null && durationMs !== null) this.close(durationMs);
    return [...this.found];
  }

  private close(endMs: number): void {
    const startMs = this.openAt ?? endMs;
    this.openAt = null;
    if (endMs > startMs) this.found.push({ startMs, endMs });
  }
}

/** `silencedetect` over the audio only, decoded to nowhere (`-f null`). */
export const silenceArgs = (source: string, input: SilenceDetectorInput) => [
  '-hide_banner',
  '-nostdin',
  '-i',
  source,
  '-vn',
  '-sn',
  '-dn',
  '-af',
  `silencedetect=noise=${input.noiseDb}dB:d=${input.minSilenceMs / 1000}`,
  '-f',
  'null',
  '-',
];

/** Measures the pauses of `source` (1 h of audio takes ~18 s on the VM, ADR 0022). */
export async function detectSilences(input: {
  readonly bins: FfmpegBins;
  readonly source: string;
  readonly detector: SilenceDetectorInput;
  readonly durationMs: number | null;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<SilenceInterval[]> {
  const report = new SilenceReport();
  const result = await runProcess(
    input.bins.ffmpeg,
    silenceArgs(input.source, input.detector),
    {
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      onErrorLine: (line) => report.read(line),
    },
  );
  if (result.aborted) throw new Error('silence detection aborted');
  if (result.timedOut)
    throw new Error(`silencedetect timed out after ${input.timeoutMs} ms`);
  if (result.code !== 0)
    throw new Error(
      `silencedetect exited with ${result.code}: ${result.stderrTail.trim()}`,
    );
  return report.intervals(input.durationMs);
}
