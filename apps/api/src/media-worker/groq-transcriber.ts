import type {
  CompleteGroqTranscriptRequest,
  GroqTranscribeJob,
  RawChunkResult,
} from '@kb-chat/contracts';
import type { ChunkPlan, Span } from './speech-chunks.js';

/** How the API answered one chunk: Groq's words, a wait, or the job is no longer ours. */
export type GroqChunkAnswer =
  | { readonly kind: 'ok'; readonly result: RawChunkResult }
  | { readonly kind: 'wait'; readonly retryAfterMs: number }
  | { readonly kind: 'lost' };

/** The API routes a Groq job uses (KBC-037); a fake in tests. */
export interface GroqJobsApi {
  sendGroqChunk(
    job: GroqTranscribeJob,
    chunk: { readonly span: Span; readonly audio: Buffer },
  ): Promise<GroqChunkAnswer>;
  /** False when the lease was lost (409). */
  completeGroq(
    job: GroqTranscribeJob,
    done: Omit<CompleteGroqTranscriptRequest, 'worker' | 'leaseId'>,
  ): Promise<boolean>;
}

export interface GroqTranscriberDeps {
  readonly api: GroqJobsApi;
  /** Where to cut the job's audio, and which file to read. */
  readonly plan: (
    job: GroqTranscribeJob,
    signal: AbortSignal,
  ) => Promise<{ readonly source: string; readonly plan: ChunkPlan }>;
  /** One chunk of `source` as FLAC. */
  readonly read: (
    source: string,
    span: Span,
    signal: AbortSignal,
  ) => Promise<Buffer>;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

export interface GroqRunOptions {
  readonly signal: AbortSignal;
  /** Chunks done, as a percentage, for the heartbeat. */
  readonly progress?: { percent: number };
}

/** How a Groq job ended: the transcript is in, or the lease went (drop the work). */
export type GroqRun = 'done' | 'lost' | 'stopped';

type Chunks = CompleteGroqTranscriptRequest['raw']['chunks'];

/** A chunk's result where it sits in the track, in seconds (ADR 0023 §4). */
const chunkOf = (span: Span, result: RawChunkResult): Chunks[number] => ({
  offset: span.startMs / 1000,
  end: span.endMs / 1000,
  result,
});

const percentOf = (done: number, total: number) =>
  Math.floor((done * 100) / total);

/** Waits in a row on one chunk before the job fails and goes back to the queue. */
const MAX_WAITS_PER_CHUNK = 30;

/**
 * The Groq adapter of the VM worker (KBC-037 FR-3, ADR 0023 §7): the track cut into VAD
 * chunks of ≤ 28 s, each sent through the API with the job's terms, a 429 waited for its
 * `retry-after` and the same chunk sent again, the chunks put together in the Mac's shape.
 */
export class GroqTranscriber {
  private readonly now: () => number;

  constructor(private readonly deps: GroqTranscriberDeps) {
    this.now = deps.now ?? Date.now;
  }

  async run(job: GroqTranscribeJob, run: GroqRunOptions): Promise<GroqRun> {
    const started = this.now();
    const { source, plan } = await this.deps.plan(job, run.signal);
    const chunks: Chunks = [];
    for (const [index, span] of plan.chunks.entries()) {
      const result = await this.transcribe(job, {
        source,
        span,
        signal: run.signal,
      });
      if (typeof result === 'string') return result;
      chunks.push(chunkOf(span, result));
      if (run.progress)
        run.progress.percent = percentOf(index + 1, plan.chunks.length);
    }
    const done = await this.deps.api.completeGroq(job, {
      termsVersion: job.termsVersion,
      vad: plan.vad,
      speechRatio: plan.speechRatio,
      elapsedMs: this.now() - started,
      raw: { chunks },
    });
    return done ? 'done' : 'lost';
  }

  /** One chunk, sent again after each wait the API or Groq asks for (AC-4). */
  private async transcribe(
    job: GroqTranscribeJob,
    chunk: { source: string; span: Span; signal: AbortSignal },
  ): Promise<RawChunkResult | 'lost' | 'stopped'> {
    const audio = await this.deps.read(chunk.source, chunk.span, chunk.signal);
    for (let wait = 0; wait <= MAX_WAITS_PER_CHUNK; wait++) {
      if (chunk.signal.aborted) return 'stopped';
      const answer = await this.deps.api.sendGroqChunk(job, {
        span: chunk.span,
        audio,
      });
      if (answer.kind !== 'wait')
        return answer.kind === 'ok' ? answer.result : 'lost';
      await this.deps.sleep(answer.retryAfterMs, chunk.signal);
    }
    throw new Error('Groq kept asking to wait: the job goes back to the queue');
  }
}
