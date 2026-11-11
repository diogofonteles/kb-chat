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

/**
 * A long source that costs nothing to make: a low-rate WAV (no encoding), for tests that
 * need a conversion still running when they interrupt it.
 */
export function makeLongWav(
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
    `sine=frequency=440:duration=${seconds}:sample_rate=8000`,
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    '-f',
    'wav',
    path,
  ]);
}

/** Where each pause starts (ms), the ffmpeg expression that mutes them and the length (s). */
function pausesOf(pausesSec: readonly number[]) {
  const starts: number[] = [];
  const spans: string[] = [];
  let at = 1;
  for (const pause of pausesSec) {
    starts.push(Math.round(at * 1000));
    spans.push(`between(t,${at},${at + pause})`);
    at += pause + 1;
  }
  return { starts, silent: spans.length > 0 ? spans.join('+') : '0', at };
}

/**
 * A tone with pauses of known length (KBC-044 AC-1): 1 s of tone, then each pause in
 * turn followed by 1 s of tone, as MP3 at `path`. Returns where each pause starts (ms).
 */
export function makeToneWithPauses(
  bins: FfmpegBins,
  path: string,
  pausesSec: readonly number[],
): number[] {
  const { starts, silent, at } = pausesOf(pausesSec);
  execFileSync(bins.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc='if(${silent},0,0.5*sin(2*PI*440*t))':s=44100:d=${at}`,
    '-ac',
    '1',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    path,
  ]);
  return starts;
}
