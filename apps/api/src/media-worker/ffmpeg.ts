import { z } from 'zod';
import { runProcess } from './process-runner.js';

export interface FfmpegBins {
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

/** What ffprobe found: the duration and whether there is an audio stream. */
export interface Probe {
  readonly durationMs: number;
  readonly hasAudio: boolean;
}

export class InvalidMediaError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'InvalidMediaError';
  }
}

const PROBE_TIMEOUT_MS = 60_000;

const probeSchema = z.object({
  streams: z.array(z.object({ codec_type: z.string().optional() })).default([]),
  format: z.object({ duration: z.string().optional() }).default({}),
});

const probeArgs = (path: string) => [
  '-v',
  'error',
  '-print_format',
  'json',
  '-show_entries',
  'stream=codec_type:format=duration',
  path,
];

/** Reads a file's duration and streams; a file ffprobe cannot read is invalid media. */
export async function probe(
  bins: FfmpegBins,
  path: string,
  signal?: AbortSignal,
): Promise<Probe> {
  const result = await runProcess(bins.ffprobe, probeArgs(path), {
    timeoutMs: PROBE_TIMEOUT_MS,
    signal,
  });
  // Not starting, a timeout or an abort is the worker's problem, never the file's.
  if (result.aborted || result.timedOut || result.code === null)
    throw new Error(`ffprobe did not finish: ${result.stderrTail.trim()}`);
  if (result.code !== 0)
    throw new InvalidMediaError(`ffprobe: ${result.stderrTail.trim()}`);
  return readProbe(result.stdout);
}

function readProbe(stdout: string): Probe {
  const parsed = probeSchema.safeParse(parseJson(stdout));
  if (!parsed.success)
    throw new InvalidMediaError('ffprobe printed no streams');
  const seconds = Number(parsed.data.format.duration);
  return {
    durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
    hasAudio: parsed.data.streams.some(
      (stream) => stream.codec_type === 'audio',
    ),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return null;
  }
}

/** The renditions of ADR 0022 §4: AAC 64 kbit/s mono in MP4, moov first (faststart). */
export const AUDIO_RENDITION_ARGS = [
  '-vn',
  '-map',
  '0:a:0',
  '-ac',
  '1',
  '-c:a',
  'aac',
  '-b:a',
  '64k',
  '-movflags',
  '+faststart',
  '-f',
  'mp4',
] as const;

/** The transcriber's input (ADR 0022 §4): 16 kHz mono FLAC, from the same decoding. */
export const FLAC_FOR_TRANSCRIPTION_ARGS = [
  '-vn',
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
] as const;

/** Percent done from one ffmpeg `-progress` line, given the input's duration. */
export function progressOf(line: string, durationMs: number): number | null {
  const match = line.match(/^out_time_(?:us|ms)=(\d+)$/);
  if (!match || durationMs <= 0) return null;
  // ffmpeg writes microseconds under both names (out_time_ms is a misnomer).
  const doneMs = Number(match[1]) / 1000;
  return Math.max(0, Math.min(99, Math.floor((doneMs / durationMs) * 100)));
}

const transcodeArgs = (
  source: string,
  targets: { audio: string; flac?: string },
) => [
  '-hide_banner',
  '-nostdin',
  '-y',
  '-i',
  source,
  ...AUDIO_RENDITION_ARGS,
  '-progress',
  'pipe:1',
  '-nostats',
  targets.audio,
  ...(targets.flac ? [...FLAC_FOR_TRANSCRIPTION_ARGS, targets.flac] : []),
];

/** Converts `source` into the audio rendition at `target`, reporting progress. */
export async function transcodeAudio(input: {
  readonly bins: FfmpegBins;
  readonly source: string;
  readonly target: string;
  /** Also writes the transcriber's FLAC here, in the same run. */
  readonly flacTarget?: string;
  readonly durationMs: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly onProgress: (percent: number) => void;
}): Promise<void> {
  const result = await runProcess(
    input.bins.ffmpeg,
    transcodeArgs(input.source, {
      audio: input.target,
      flac: input.flacTarget,
    }),
    {
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      onLine: (line) => {
        const percent = progressOf(line, input.durationMs);
        if (percent !== null) input.onProgress(percent);
      },
    },
  );
  assertFinished(result, input.timeoutMs);
}

function assertFinished(
  result: Awaited<ReturnType<typeof runProcess>>,
  timeoutMs: number,
): void {
  if (result.aborted) throw new Error('conversion aborted');
  if (result.timedOut)
    throw new Error(`ffmpeg timed out after ${timeoutMs} ms`);
  if (result.code !== 0)
    throw new Error(
      `ffmpeg exited with ${result.code}: ${result.stderrTail.trim()}`,
    );
}
