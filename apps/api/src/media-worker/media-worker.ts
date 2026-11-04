import { stat, rm, utimes, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import type {
  SilencesJob,
  VmWorkerJob,
  WaveformJob,
  WorkerJob,
} from '@kb-chat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { MediaJobsApi } from './api-client.js';
import {
  InvalidMediaError,
  probe,
  transcodeAudio,
  type FfmpegBins,
} from './ffmpeg.js';
import { detectSilences } from './silence-detector.js';
import { measurePeaks } from './waveform.js';

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
/** Decoding the audio, at the same scale as the silences. */
const waveformTimeoutFor = (durationMs: number) =>
  Math.max(10 * 60_000, durationMs);
/** Silences take ~18 s per hour on the VM (ADR 0022): ten minutes, or the audio's length. */
const silencesTimeoutFor = (durationMs: number) =>
  Math.max(10 * 60_000, durationMs);

/** What a job's lease being lost stops, for the log. */
const WORK_OF: Record<VmWorkerJob['kind'], string> = {
  transcode: 'conversion',
  silences: 'silence detection',
  waveform: 'waveform',
};

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

  /** Runs one job; never throws (failures are reported to the API or logged). */
  async process(job: VmWorkerJob, shutdown: AbortSignal): Promise<void> {
    if (job.kind === 'silences')
      return this.processMeasure({
        job,
        shutdown,
        work: (signal) => this.measure(job, signal),
      });
    if (job.kind === 'waveform')
      return this.processMeasure({
        job,
        shutdown,
        work: (signal) => this.measureWaveform(job, signal),
      });
    return this.processTranscode(job, shutdown);
  }

  /**
   * Measures something of a ready item's audio (the pauses, KBC-044 FR-1; the peaks,
   * KBC-066). A failure is reported as one the queue retries: the item stays ready, without
   * the measure until it works.
   */
  private async processMeasure(run: {
    readonly job: SilencesJob | WaveformJob;
    readonly shutdown: AbortSignal;
    readonly work: (signal: AbortSignal) => Promise<void>;
  }): Promise<void> {
    const { job, shutdown } = run;
    const abort = new AbortController();
    const stop = () => abort.abort();
    shutdown.addEventListener('abort', stop, { once: true });
    const beats = this.startHeartbeat(job, { progress: null, abort });
    try {
      await run.work(abort.signal);
    } catch (err) {
      if (!abort.signal.aborted) await this.reportFailure(job, err);
    } finally {
      clearInterval(beats);
      shutdown.removeEventListener('abort', stop);
    }
  }

  private async measure(job: SilencesJob, signal: AbortSignal): Promise<void> {
    const { bins, log, api } = this.deps;
    const source = this.resolve(job.sourcePath);
    const started = Date.now();
    const { durationMs } = await probe(bins, source, signal);
    const intervals = await detectSilences({
      bins,
      source,
      detector: job.detector,
      durationMs,
      timeoutMs: silencesTimeoutFor(durationMs),
      signal,
    });
    const elapsedMs = Date.now() - started;
    const done = await api.completeSilences(job, {
      detectorVersion: job.detector.version,
      intervals,
      elapsedMs,
    });
    if (!done) throw new LeaseLostError();
    log.info(
      { job: job.id, pauses: intervals.length, elapsedMs },
      'silences measured',
    );
  }

  /** The peaks of the audio rendition, one byte each (KBC-066). */
  private async measureWaveform(
    job: WaveformJob,
    signal: AbortSignal,
  ): Promise<void> {
    const { bins, log, api } = this.deps;
    const source = this.resolve(job.sourcePath);
    const started = Date.now();
    const { durationMs } = await probe(bins, source, signal);
    const peaks = await measurePeaks({
      bins,
      source,
      peaksPerSecond: job.peaksPerSecond,
      timeoutMs: waveformTimeoutFor(durationMs),
      signal,
    });
    const elapsedMs = Date.now() - started;
    const done = await api.completeWaveform(job, {
      version: job.version,
      peaks: peaks.toString('base64'),
      elapsedMs,
    });
    if (!done) throw new LeaseLostError();
    log.info(
      { job: job.id, peaks: peaks.length, elapsedMs },
      'waveform measured',
    );
  }

  /** Converts one job (KBC-034). */
  private async processTranscode(
    job: WorkerJob,
    shutdown: AbortSignal,
  ): Promise<void> {
    const abort = new AbortController();
    const stop = () => abort.abort();
    shutdown.addEventListener('abort', stop, { once: true });
    const progress = { percent: 0 };
    const beats = this.startHeartbeat(job, { progress, abort });
    const target = { path: '', flac: '' };
    try {
      target.path = this.resolve(job.targetPath);
      target.flac = job.flacTargetPath ? this.resolve(job.flacTargetPath) : '';
      await this.transcode(job, {
        target: target.path,
        flacTarget: target.flac || undefined,
        progress,
        signal: abort.signal,
      });
    } catch (err) {
      await removeFiles([target.path, target.flac]);
      if (!abort.signal.aborted) await this.reportFailure(job, err);
    } finally {
      clearInterval(beats);
      shutdown.removeEventListener('abort', stop);
    }
  }

  private async transcode(
    job: WorkerJob,
    run: {
      target: string;
      flacTarget?: string;
      progress: { percent: number };
      signal: AbortSignal;
    },
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
      flacTarget: run.flacTarget,
      durationMs: input.durationMs,
      timeoutMs: timeoutFor(input.durationMs),
      signal: run.signal,
      onProgress: (percent) => (run.progress.percent = percent),
    });
    await this.complete(job, run);
  }

  /** Reads the result back and hands it to the API; a lost lease drops it. */
  private async complete(
    job: WorkerJob,
    run: { target: string; flacTarget?: string; signal: AbortSignal },
  ): Promise<void> {
    // An unreadable result is the conversion's fault, never the uploaded file's.
    const output = await probe(this.deps.bins, run.target, run.signal).catch(
      (err: unknown) => {
        throw new Error(`the converted file cannot be read: ${String(err)}`);
      },
    );
    const { size } = await stat(run.target);
    const flac = run.flacTarget ? await stat(run.flacTarget) : null;
    const done = await this.deps.api.complete(job, {
      durationMs: output.durationMs,
      bytes: size,
      ...(flac ? { flacBytes: flac.size } : {}),
    });
    if (!done) throw new LeaseLostError();
    this.deps.log.info({ job: job.id, bytes: size }, 'converted');
  }

  private startHeartbeat(
    job: VmWorkerJob,
    state: { progress: { percent: number } | null; abort: AbortController },
  ): NodeJS.Timeout {
    return setInterval(() => {
      // A long conversion is the worker working: the healthcheck must see it alive.
      void this.touchAlive();
      const percent = state.progress?.percent ?? null;
      this.deps.api.heartbeat(job, percent).then(
        (held) => {
          if (held) return;
          this.deps.log.warn(
            { job: job.id },
            `lease lost: stopping the ${WORK_OF[job.kind]}`,
          );
          state.abort.abort();
        },
        (err: unknown) =>
          this.deps.log.warn({ err, job: job.id }, 'heartbeat failed'),
      );
    }, this.deps.heartbeatMs ?? HEARTBEAT_MS);
  }

  private async reportFailure(job: VmWorkerJob, err: unknown): Promise<void> {
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
    this.deps.log.error(
      { job: job.id, kind: job.kind, failure, detail },
      'media job failed',
    );
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

/** Removes the given work files (empty paths are none). */
async function removeFiles(paths: readonly string[]): Promise<void> {
  await Promise.all(
    paths
      .filter((path) => path !== '')
      .map((path) => rm(path, { force: true })),
  );
}

class LeaseLostError extends Error {
  constructor() {
    super('the lease was lost before completion');
    this.name = 'LeaseLostError';
  }
}
