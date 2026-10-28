import { stat, rm, utimes, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import type { WorkerJob } from '@kb-chat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { MediaJobsApi } from './api-client.js';
import {
  InvalidMediaError,
  probe,
  transcodeAudio,
  type FfmpegBins,
} from './ffmpeg.js';

export interface MediaWorkerDeps {
  readonly api: MediaJobsApi;
  readonly bins: FfmpegBins;
  readonly mediaDir: string;
  readonly log: FastifyBaseLogger;
  readonly pollMs: number;
  readonly aliveFile?: string;
  /** Heartbeat period (ADR 0022: 15 s); tests shorten it. */
  readonly heartbeatMs?: number;
}

const HEARTBEAT_MS = 15_000;
/** At least half an hour, or twice the audio's length (1 h converts in ~50 s on the VM). */
const timeoutFor = (durationMs: number) =>
  Math.max(30 * 60_000, 2 * durationMs);

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * The media worker (ADR 0022 §3): one job at a time, leased from the API, converted with
 * ffmpeg, with a heartbeat while it runs. A lost lease or a shutdown stops ffmpeg and
 * leaves the job to the queue; nothing it wrote survives.
 */
export class MediaWorker {
  constructor(private readonly deps: MediaWorkerDeps) {}

  async run(signal: AbortSignal): Promise<void> {
    this.deps.log.info(
      { mediaDir: this.deps.mediaDir },
      'media worker started',
    );
    while (!signal.aborted) {
      await this.touchAlive();
      const job = await this.deps.api.lease().catch((err: unknown) => {
        this.deps.log.warn({ err }, 'media worker could not lease a job');
        return null;
      });
      if (job) await this.process(job, signal);
      else await sleep(this.deps.pollMs, signal);
    }
    this.deps.log.info('media worker stopped');
  }

  /** Converts one job; never throws (failures are reported to the API or logged). */
  async process(job: WorkerJob, shutdown: AbortSignal): Promise<void> {
    const abort = new AbortController();
    const stop = () => abort.abort();
    shutdown.addEventListener('abort', stop, { once: true });
    const progress = { percent: 0 };
    const beats = this.startHeartbeat(job, { progress, abort });
    const target = { path: '' };
    try {
      target.path = this.resolve(job.targetPath);
      await this.transcode(job, {
        target: target.path,
        progress,
        signal: abort.signal,
      });
    } catch (err) {
      if (target.path) await rm(target.path, { force: true });
      if (!abort.signal.aborted) await this.reportFailure(job, err);
    } finally {
      clearInterval(beats);
      shutdown.removeEventListener('abort', stop);
    }
  }

  private async transcode(
    job: WorkerJob,
    run: { target: string; progress: { percent: number }; signal: AbortSignal },
  ): Promise<void> {
    const { bins, log } = this.deps;
    const source = this.resolve(job.sourcePath);
    const input = await probe(bins, source, run.signal);
    if (!input.hasAudio)
      throw new InvalidMediaError('the file has no audio stream');
    log.info({ job: job.id, durationMs: input.durationMs }, 'converting');
    await transcodeAudio({
      bins,
      source,
      target: run.target,
      durationMs: input.durationMs,
      timeoutMs: timeoutFor(input.durationMs),
      signal: run.signal,
      onProgress: (percent) => (run.progress.percent = percent),
    });
    await this.complete(job, { target: run.target, signal: run.signal });
  }

  /** Reads the result back and hands it to the API; a lost lease drops it. */
  private async complete(
    job: WorkerJob,
    run: { target: string; signal: AbortSignal },
  ): Promise<void> {
    const output = await probe(this.deps.bins, run.target, run.signal);
    const { size } = await stat(run.target);
    const done = await this.deps.api.complete(job, {
      durationMs: output.durationMs,
      bytes: size,
    });
    if (!done) throw new LeaseLostError();
    this.deps.log.info({ job: job.id, bytes: size }, 'converted');
  }

  private startHeartbeat(
    job: WorkerJob,
    state: { progress: { percent: number }; abort: AbortController },
  ): NodeJS.Timeout {
    return setInterval(() => {
      this.deps.api.heartbeat(job, state.progress.percent).then(
        (held) => {
          if (held) return;
          this.deps.log.warn(
            { job: job.id },
            'lease lost: stopping the conversion',
          );
          state.abort.abort();
        },
        (err: unknown) =>
          this.deps.log.warn({ err, job: job.id }, 'heartbeat failed'),
      );
    }, this.deps.heartbeatMs ?? HEARTBEAT_MS);
  }

  private async reportFailure(job: WorkerJob, err: unknown): Promise<void> {
    const detail = err instanceof Error ? err.message : String(err);
    if (err instanceof LeaseLostError) {
      this.deps.log.warn(
        { job: job.id },
        'lease lost before completion: result dropped',
      );
      return;
    }
    const failure =
      err instanceof InvalidMediaError ? 'invalid-audio' : 'conversion-failed';
    this.deps.log.error({ job: job.id, failure, detail }, 'conversion failed');
    await this.deps.api
      .fail(job, { failure, detail: detail.slice(0, 2_000) })
      .catch((reportErr: unknown) =>
        this.deps.log.error(
          { err: reportErr, job: job.id },
          'could not report the failure',
        ),
      );
  }

  private async touchAlive(): Promise<void> {
    const file = this.deps.aliveFile;
    if (!file) return;
    const now = new Date();
    await utimes(file, now, now).catch(() => writeFile(file, ''));
  }

  /** A path the API gave, inside the media folder (never `..` or absolute). */
  private resolve(path: string): string {
    const relative = normalize(path);
    if (isAbsolute(relative) || relative.split(sep).includes('..'))
      throw new Error(`job path outside the media directory: ${path}`);
    return join(this.deps.mediaDir, relative);
  }
}

class LeaseLostError extends Error {
  constructor() {
    super('the lease was lost before completion');
    this.name = 'LeaseLostError';
  }
}
