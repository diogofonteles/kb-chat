import { execFileSync } from 'node:child_process';
import type { FfmpegBins } from '../src/media-worker/ffmpeg.js';

/** ffmpeg and ffprobe by absolute path (the worker never uses a shell or PATH lookup). */
export function ffmpegBins(): FfmpegBins {
  const find = (name: string) =>
    process.env[`${name.toUpperCase()}_BIN`] ??
    execFileSync('/bin/sh', ['-c', `command -v ${name}`])
      .toString()
      .trim();
  return { ffmpeg: find('ffmpeg'), ffprobe: find('ffprobe') };
}

/** A tone of `seconds` as MP3 at `path`, made by ffmpeg (no binary fixture in git). */
export function makeTone(
  bins: FfmpegBins,
  path: string,
  seconds: number,
): void {
  execFileSync(bins.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${seconds}`,
    '-ac',
    '2',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    path,
  ]);
}
