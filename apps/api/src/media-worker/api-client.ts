import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  groqChunkResultSchema,
  vmWorkerJobSchema,
  type CompleteCutRequest,
  type CompleteSilencesRequest,
  type CompleteTranscodeRequest,
  type CompleteWaveformRequest,
  type CompleteGroqTranscriptRequest,
  type CutJob,
  type FailJobRequest,
  type GroqTranscribeJob,
  type SilencesJob,
  type VmWorkerJob,
  type WaveformJob,
  type WorkerJob,
} from '@kb-chat/contracts';
import { retryAfterMsOf } from '../adapters/groq-client.js';
import type { GroqChunkAnswer, GroqJobsApi } from './groq-transcriber.js';
import type { Span } from './speech-chunks.js';

/** What the worker loop needs from the API (ADR 0022 §3); a fake stands in for tests. */
export interface MediaJobsApi extends GroqJobsApi {
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
      // `transcribe`: the API gives the VM only the ones routed to Groq (KBC-037).
      kinds: ['transcode', 'silences', 'waveform', 'cut', 'transcribe'],
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

  /** One chunk to Groq through the API (KBC-037): 429 says how long to wait first. */
  async sendGroqChunk(
    job: GroqTranscribeJob,
    chunk: { readonly span: Span; readonly audio: Buffer },
  ): Promise<GroqChunkAnswer> {
    const query = new URLSearchParams({
      worker: this.options.worker,
      leaseId: job.leaseId,
      startMs: String(chunk.span.startMs),
      endMs: String(chunk.span.endMs),
      termsVersion: String(job.termsVersion),
    });
    const response = await this.send(
      `/api/v1/media-worker/jobs/${job.id}/groq/chunks?${query.toString()}`,
      {
        body: new Uint8Array(chunk.audio),
        contentType: 'audio/flac',
        // The API waits for Groq: about a second, two minutes at worst.
        timeoutMs: 150_000,
      },
    );
    if (response.status === 409) return { kind: 'lost' };
    if (response.status === 429)
      return {
        kind: 'wait',
        retryAfterMs: retryAfterMsOf(response.headers.get('retry-after')),
      };
    if (!response.ok) throw await this.failure(response);
    const { result } = groqChunkResultSchema.parse(await response.json());
    return { kind: 'ok', result };
  }

  completeGroq(
    job: GroqTranscribeJob,
    done: Omit<CompleteGroqTranscriptRequest, 'worker' | 'leaseId'>,
  ): Promise<boolean> {
    return this.onJob(job, 'groq/transcript', done);
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
    return this.send(path, {
      body: JSON.stringify(body),
      contentType: 'application/json',
    });
  }

  private send(
    path: string,
    payload: {
      readonly body: string | Uint8Array;
      readonly contentType: string;
      readonly timeoutMs?: number;
    },
  ): Promise<Response> {
    const doFetch = this.options.fetch ?? fetch;
    return doFetch(new URL(path, this.options.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.token}`,
        'content-type': payload.contentType,
        [CSRF_HEADER]: CSRF_HEADER_VALUE,
      },
      body: payload.body,
      signal: AbortSignal.timeout(payload.timeoutMs ?? 30_000),
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
