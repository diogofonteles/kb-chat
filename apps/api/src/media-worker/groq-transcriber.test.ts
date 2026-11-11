import type {
  CompleteGroqTranscriptRequest,
  GroqTranscribeJob,
} from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import {
  GroqTranscriber,
  type GroqChunkAnswer,
  type GroqJobsApi,
} from './groq-transcriber.js';
import type { ChunkPlan, Span } from './speech-chunks.js';

const JOB: GroqTranscribeJob = {
  id: '11111111-1111-4111-8111-111111111111',
  leaseId: '22222222-2222-4222-8222-222222222222',
  kind: 'transcribe',
  provider: 'groq',
  mediaId: '33333333-3333-4333-8333-333333333333',
  attempt: 1,
  leaseMs: 60_000,
  durationMs: 40_000,
  sourcePath: 'flac/m.flac',
  renditionPath: null,
  termsVersion: 4,
};

const PLAN: ChunkPlan = {
  chunks: [
    { startMs: 0, endMs: 20_000 },
    { startMs: 21_000, endMs: 40_000 },
  ],
  vad: 'applied',
  speechRatio: 0.9,
};

const said = (text: string): GroqChunkAnswer => ({
  kind: 'ok',
  result: { segments: [{ start: 0, end: 1, text }] },
});

/** The API as the worker sees it, answering from a script of answers per call. */
function fakeApi(answers: GroqChunkAnswer[]) {
  const sent: Span[] = [];
  const completed: Omit<CompleteGroqTranscriptRequest, 'worker' | 'leaseId'>[] =
    [];
  const api: GroqJobsApi = {
    sendGroqChunk: async (_job, chunk) => {
      sent.push(chunk.span);
      return answers.shift() ?? said('…');
    },
    completeGroq: async (_job, done) => {
      completed.push(done);
      return true;
    },
  };
  return { api, sent, completed };
}

function transcriberWith(api: GroqJobsApi) {
  const slept: number[] = [];
  const transcriber = new GroqTranscriber({
    api,
    plan: async () => ({ source: '/media/flac/m.flac', plan: PLAN }),
    read: async (_source, span) => Buffer.from(`${span.startMs}`),
    sleep: async (ms) => {
      slept.push(ms);
    },
    now: () => 1_000,
  });
  return { transcriber, slept };
}

describe('GroqTranscriber (KBC-037 FR-3)', () => {
  it('waits the retry-after of a 429 and sends the same chunk again, keeping the job (AC-4)', async () => {
    const { api, sent, completed } = fakeApi([
      { kind: 'wait', retryAfterMs: 30_000 },
      said('Primeiro'),
      said('Segundo'),
    ]);
    const { transcriber, slept } = transcriberWith(api);

    const outcome = await transcriber.run(JOB, {
      signal: new AbortController().signal,
    });

    expect(outcome).toBe('done');
    expect(slept).toEqual([30_000]);
    expect(sent).toEqual([PLAN.chunks[0], PLAN.chunks[0], PLAN.chunks[1]]);
    expect(completed).toHaveLength(1);
  });

  it("puts the chunks together in the Mac's shape, offsets in seconds", async () => {
    const { api, completed } = fakeApi([said('Um'), said('Dois')]);
    const progress = { percent: 0 };

    await transcriberWith(api).transcriber.run(JOB, {
      signal: new AbortController().signal,
      progress,
    });

    expect(completed[0]).toEqual({
      termsVersion: 4,
      vad: 'applied',
      speechRatio: 0.9,
      elapsedMs: 0,
      raw: {
        chunks: [
          {
            offset: 0,
            end: 20,
            result: { segments: [{ start: 0, end: 1, text: 'Um' }] },
          },
          {
            offset: 21,
            end: 40,
            result: { segments: [{ start: 0, end: 1, text: 'Dois' }] },
          },
        ],
      },
    });
    expect(progress.percent).toBe(100);
  });

  it('stops at once when the API says the job is no longer ours (cap or key, FR-4)', async () => {
    const { api, sent, completed } = fakeApi([{ kind: 'lost' }]);

    const outcome = await transcriberWith(api).transcriber.run(JOB, {
      signal: new AbortController().signal,
    });

    expect(outcome).toBe('lost');
    expect(sent).toHaveLength(1);
    expect(completed).toEqual([]);
  });

  it('sends nothing more after a shutdown', async () => {
    const { api, sent } = fakeApi([]);
    const stop = new AbortController();
    stop.abort();

    const outcome = await transcriberWith(api).transcriber.run(JOB, {
      signal: stop.signal,
    });

    expect(outcome).toBe('stopped');
    expect(sent).toEqual([]);
  });

  it('gives up on a chunk Groq keeps refusing, so the queue retries the job later', async () => {
    const waits = Array.from({ length: 40 }, () => ({
      kind: 'wait' as const,
      retryAfterMs: 1_000,
    }));
    const { api } = fakeApi(waits);

    await expect(
      transcriberWith(api).transcriber.run(JOB, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/kept asking to wait/);
  });
});
