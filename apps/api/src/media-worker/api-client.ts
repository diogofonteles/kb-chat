import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  vmWorkerJobSchema,
  type CompleteCutRequest,
  type CompleteSilencesRequest,
  type CompleteTranscodeRequest,
  type CompleteWaveformRequest,
  type CutJob,
  type FailJobRequest,
  type SilencesJob,
  type VmWorkerJob,
  type WaveformJob,
  type WorkerJob,
} from '@kb-chat/contracts';

/** What the worker loop needs from the API (ADR 0022 §3); a fake stands in for tests. */
export interface MediaJobsApi {
  /** The oldest conversion, silences or waveform job, or null when there is none. */
  lease(): Promise<VmWorkerJob | null>;
  /** False when the lease is no longer this worker's (409): drop the work. */
  heartbeat(job: VmWorkerJob, progress: number | null): Promise<boolean>;
  complete(
    job: WorkerJob,
    done: Omit<CompleteTranscodeRequest, 'worker' | 'leaseId'>,
  ): Promise<boolean>;
  /** The pauses found in a silences job (KBC-044 FR-1). */
  completeSilences(
    job: SilencesJob,
    done: Omit<CompleteSilencesRequest, 'worker' | 'leaseId'>,
  ): Promise<boolean>;
  /** The peaks of a waveform job (KBC-066). */
  completeWaveform(
    job: WaveformJob,
    done: Omit<CompleteWaveformRequest, 'worker' | 'leaseId'>,
  ): Promise<boolean>;
  /** The file of a cut job and its real bounds (KBC-068 FR-2). */
  completeCut(
    job: CutJob,
    done: Omit<CompleteCutRequest, 'worker' | 'leaseId'>,
  ): Promise<boolean>;
  fail(
    job: VmWorkerJob,
    failure: Omit<FailJobRequest, 'worker' | 'leaseId'>,
  ): Promise<boolean>;
}

export class MediaApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MediaApiError';
  }
}

/** The worker protocol over HTTP, with the worker token. */
export class HttpMediaJobsApi implements MediaJobsApi {
  constructor(
    private readonly options: {
      readonly baseUrl: string;
      readonly token: string;
      readonly worker: string;
      readonly fetch?: typeof fetch;
    },
  ) {}

  async lease(): Promise<VmWorkerJob | null> {
    const response = await this.post('/api/v1/media-worker/jobs/lease', {
      worker: this.options.worker,
      kinds: ['transcode', 'silences', 'waveform', 'cut'],
    });
    if (response.status === 204) return null;
    if (!response.ok) throw await this.failure(response);
    return vmWorkerJobSchema.parse(await response.json());
  }

  heartbeat(job: VmWorkerJob, progress: number | null): Promise<boolean> {
    return this.onJob(job, 'heartbeat', { progress });
  }

  complete(
    job: WorkerJob,
    done: Omit<CompleteTranscodeRequest, 'worker' | 'leaseId'>,
  ): Promise<boolean> {
    return this.onJob(job, 'complete', done);
  }

  completeSilences(
    job: SilencesJob,
    done: Omit<CompleteSilencesRequest, 'worker' | 'leaseId'>,
  ): Promise<boolean> {
    return this.onJob(job, 'silences', done);
  }

  completeWaveform(
    job: WaveformJob,
    done: Omit<CompleteWaveformRequest, 'worker' | 'leaseId'>,
  ): Promise<boolean> {
    return this.onJob(job, 'waveform', done);
  }

  completeCut(
    job: CutJob,
    done: Omit<CompleteCutRequest, 'worker' | 'leaseId'>,
  ): Promise<boolean> {
    return this.onJob(job, 'cut', done);
  }

  fail(
    job: VmWorkerJob,
    failure: Omit<FailJobRequest, 'worker' | 'leaseId'>,
  ): Promise<boolean> {
    return this.onJob(job, 'fail', failure);
  }

  /** 204 is done; 409 means the lease was lost; anything else is an error. */
  private async onJob(
    job: VmWorkerJob,
    action: string,
    body: object,
  ): Promise<boolean> {
    const response = await this.post(
      `/api/v1/media-worker/jobs/${job.id}/${action}`,
      {
        worker: this.options.worker,
        leaseId: job.leaseId,
        ...body,
      },
    );
    if (response.status === 204) return true;
    if (response.status === 409) return false;
    throw await this.failure(response);
  }

  private post(path: string, body: object): Promise<Response> {
    const doFetch = this.options.fetch ?? fetch;
    return doFetch(new URL(path, this.options.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.token}`,
        'content-type': 'application/json',
        [CSRF_HEADER]: CSRF_HEADER_VALUE,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  }

  private async failure(response: Response): Promise<MediaApiError> {
    const text = await response.text().catch(() => '');
    return new MediaApiError(
      response.status,
      `API answered ${response.status}: ${text.slice(0, 300)}`,
    );
  }
}
