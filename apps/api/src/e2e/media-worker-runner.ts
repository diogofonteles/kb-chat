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
 * Conversions a run does at once. One was not enough: the queue is first in, first out, and
 * a two-hour lecture (media-transcript.spec.ts) holds a worker for minutes while every other
 * test of the shard waits, `queued`, past its time limit of 60 s.
 */
const DEFAULT_WORKERS = 3;

function workerCount(): number {
  const count = Number(process.env['KBC_E2E_MEDIA_WORKERS'] ?? DEFAULT_WORKERS);
  if (!Number.isInteger(count) || count < 1)
    throw new Error('KBC_E2E_MEDIA_WORKERS must be a positive integer');
  return count;
}

/**
 * The media workers of the E2E run, in this process: they lease from the API over HTTP,
 * with real ffmpeg, as the media-worker container does in production (ADR 0022). The
 * returned function stops them; the server decides when (it also closes the API then).
 */
export function startMediaWorkers(options: {
  readonly apiUrl: string;
  readonly token: string;
  readonly mediaDir: string;
  readonly log: FastifyBaseLogger;
}): () => void {
  const bins = { ffmpeg: binary('ffmpeg'), ffprobe: binary('ffprobe') };
  const shutdown = new AbortController();
  for (let index = 1; index <= workerCount(); index++) {
    const worker = new MediaWorker({
      api: new HttpMediaJobsApi({
        baseUrl: options.apiUrl,
        token: options.token,
        worker: `e2e-${index}`,
      }),
      bins,
      mediaDir: options.mediaDir,
      log: options.log,
      pollMs: 300,
    });
    void worker.run(shutdown.signal);
  }
  return () => shutdown.abort();
}
