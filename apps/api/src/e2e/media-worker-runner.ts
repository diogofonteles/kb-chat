import { execFileSync } from 'node:child_process';
import type { FastifyBaseLogger } from 'fastify';
import { HttpMediaJobsApi } from '../media-worker/api-client.js';
import { MediaWorker } from '../media-worker/media-worker.js';

/** ffmpeg by absolute path: FFMPEG_BIN/FFPROBE_BIN, else found on the PATH. */
function binary(name: 'ffmpeg' | 'ffprobe'): string {
  const fromEnv = process.env[`${name.toUpperCase()}_BIN`];
  if (fromEnv) return fromEnv;
  try {
    return execFileSync('/bin/sh', ['-c', `command -v ${name}`])
      .toString()
      .trim();
  } catch {
    throw new Error(
      `The E2E server needs ${name} (KBC-034): install it (apt/brew)`,
    );
  }
}

/**
 * The media worker of the E2E run, in this process: it leases from the API over HTTP,
 * with real ffmpeg, as the media-worker container does in production (ADR 0022). The
 * returned function stops it; the server decides when (it also closes the API then).
 */
export function startMediaWorker(options: {
  readonly apiUrl: string;
  readonly token: string;
  readonly mediaDir: string;
  readonly log: FastifyBaseLogger;
}): () => void {
  const worker = new MediaWorker({
    api: new HttpMediaJobsApi({
      baseUrl: options.apiUrl,
      token: options.token,
      worker: 'e2e',
    }),
    bins: { ffmpeg: binary('ffmpeg'), ffprobe: binary('ffprobe') },
    mediaDir: options.mediaDir,
    log: options.log,
    pollMs: 300,
  });
  const shutdown = new AbortController();
  void worker.run(shutdown.signal);
  return () => shutdown.abort();
}
