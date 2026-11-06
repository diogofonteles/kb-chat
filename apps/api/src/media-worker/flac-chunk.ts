import type { FfmpegBins } from './ffmpeg.js';
import { runProcess } from './process-runner.js';

/** A 28 s chunk decodes and encodes in well under a second; this is a safety net. */
const CHUNK_TIMEOUT_MS = 60_000;

const seconds = (ms: number) => (ms / 1000).toFixed(3);

/** One chunk of `source` as 16 kHz mono FLAC on stdout (Groq's preferred input). */
export const chunkArgs = (input: {
  readonly source: string;
  readonly startMs: number;
  readonly endMs: number;
}) => [
  '-hide_banner',
  '-nostdin',
  '-ss',
  seconds(input.startMs),
  '-to',
  seconds(input.endMs),
  '-i',
  input.source,
  '-map',
  '0:a:0',
  '-ac',
  '1',
  '-ar',
  '16000',
  '-c:a',
  'flac',
  '-f',
  'flac',
  '-',
];

/** Reads one chunk of the track into memory (KBC-037 FR-3); never a file on disk. */
export async function readFlacChunk(input: {
  readonly bins: FfmpegBins;
  readonly source: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly signal?: AbortSignal;
}): Promise<Buffer> {
  const parts: Buffer[] = [];
  const result = await runProcess(input.bins.ffmpeg, chunkArgs(input), {
    timeoutMs: CHUNK_TIMEOUT_MS,
    signal: input.signal,
    onData: (data) => parts.push(data),
  });
  if (result.aborted) throw new Error('chunk extraction aborted');
  if (result.timedOut) throw new Error('chunk extraction timed out');
  if (result.code !== 0)
    throw new Error(
      `ffmpeg exited with ${result.code}: ${result.stderrTail.trim()}`,
    );
  return Buffer.concat(parts);
}
