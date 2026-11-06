import { describe, expect, it } from 'vitest';
import {
  SILENCE_DETECTOR,
  type SilencesJob,
  type WorkerJob,
} from '@kb-chat/contracts';
import { HttpMediaJobsApi, MediaApiError } from './api-client.js';

const JOB: WorkerJob = {
  id: '11111111-1111-4111-8111-111111111111',
  leaseId: '22222222-2222-4222-8222-222222222222',
  kind: 'transcode',
  mediaId: '33333333-3333-4333-8333-333333333333',
  attempt: 1,
  sourcePath: 'uploads/x.upload',
  targetPath: 'audio/x.work.m4a',
  leaseMs: 60_000,
};

function apiAnswering(status: number, body?: object) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body ? JSON.stringify(body) : null, { status });
  };
  const api = new HttpMediaJobsApi({
    baseUrl: 'http://api:3000',
    token: 'worker-token',
    worker: 'vm',
    fetch: fakeFetch,
  });
  return { api, calls };
}

describe('HttpMediaJobsApi', () => {
  it('leases with the token and reads the job', async () => {
    const { api, calls } = apiAnswering(200, JOB);
    expect(await api.lease()).toEqual(JOB);
    expect(calls[0]?.url).toBe(
      'http://api:3000/api/v1/media-worker/jobs/lease',
    );
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer worker-token');
    expect(headers.get('x-requested-with')).toBe('kb-chat');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      worker: 'vm',
      kinds: ['transcode', 'silences', 'waveform', 'cut', 'transcribe'],
    });
  });

  it('reads a silences job and sends its pauses (KBC-044)', async () => {
    const silences: SilencesJob = {
      id: JOB.id,
      leaseId: JOB.leaseId,
      kind: 'silences',
      mediaId: JOB.mediaId,
      attempt: 1,
      sourcePath: 'audio/x.m4a',
      leaseMs: 60_000,
      detector: SILENCE_DETECTOR,
    };
    expect(await apiAnswering(200, silences).api.lease()).toEqual(silences);
    const { api, calls } = apiAnswering(204);
    const done = {
      detectorVersion: 1,
      intervals: [{ startMs: 1_000, endMs: 2_500 }],
      elapsedMs: 30,
    };
    expect(await api.completeSilences(silences, done)).toBe(true);
    expect(calls[0]?.url).toBe(
      `http://api:3000/api/v1/media-worker/jobs/${JOB.id}/silences`,
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      worker: 'vm',
      leaseId: JOB.leaseId,
      ...done,
    });
  });

  it('reads 204 as an empty queue', async () => {
    expect(await apiAnswering(204).api.lease()).toBeNull();
  });

  it('turns any other answer into an error that names the status', async () => {
    const failing = apiAnswering(500, { error: 'boom' }).api;
    await expect(failing.lease()).rejects.toBeInstanceOf(MediaApiError);
    await expect(failing.lease()).rejects.toThrow(/API answered 500/);
    await expect(failing.heartbeat(JOB, 10)).rejects.toThrow(
      /API answered 500/,
    );
  });

  it('sends the lease on every job call and reads 409 as a lost lease', async () => {
    const { api, calls } = apiAnswering(204);
    expect(await api.heartbeat(JOB, 40)).toBe(true);
    expect(await api.complete(JOB, { durationMs: 1, bytes: 2 })).toBe(true);
    expect(
      await api.fail(JOB, { failure: 'conversion-failed', detail: 'x' }),
    ).toBe(true);
    expect(calls.map((call) => call.url.split('/').pop())).toEqual([
      'heartbeat',
      'complete',
      'fail',
    ]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      worker: 'vm',
      leaseId: JOB.leaseId,
      progress: 40,
    });
    expect(await apiAnswering(409).api.heartbeat(JOB, 1)).toBe(false);
  });
});

describe('HttpMediaJobsApi: Groq chunks (KBC-037)', () => {
  const GROQ_JOB = {
    id: '11111111-1111-4111-8111-111111111111',
    leaseId: '22222222-2222-4222-8222-222222222222',
    kind: 'transcribe',
    provider: 'groq',
    mediaId: '33333333-3333-4333-8333-333333333333',
    attempt: 1,
    leaseMs: 60_000,
    durationMs: 30_000,
    sourcePath: 'audio/x.flac',
    renditionPath: null,
    termsVersion: 3,
  } as const;
  const chunk = {
    span: { startMs: 1_000, endMs: 20_000 },
    audio: Buffer.from('fLaC'),
  };

  function answering(response: () => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = new HttpMediaJobsApi({
      baseUrl: 'http://api:3000',
      token: 'worker-token',
      worker: 'vm',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return response();
      },
    });
    return { api, calls };
  }

  it('sends the FLAC with where it sits and reads the words back', async () => {
    const result = { segments: [{ start: 0, end: 1, text: 'Hoasca' }] };
    const { api, calls } = answering(() => Response.json({ result }));
    expect(await api.sendGroqChunk(GROQ_JOB, chunk)).toEqual({
      kind: 'ok',
      result,
    });
    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe(
      `/api/v1/media-worker/jobs/${GROQ_JOB.id}/groq/chunks`,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      worker: 'vm',
      leaseId: GROQ_JOB.leaseId,
      startMs: '1000',
      endMs: '20000',
      termsVersion: '3',
    });
    expect(new Headers(calls[0]?.init.headers).get('content-type')).toBe(
      'audio/flac',
    );
  });

  it('waits on 429 for its retry-after, and drops the job on 409', async () => {
    const limited = answering(
      () =>
        new Response(null, { status: 429, headers: { 'retry-after': '30' } }),
    );
    expect(await limited.api.sendGroqChunk(GROQ_JOB, chunk)).toEqual({
      kind: 'wait',
      retryAfterMs: 30_000,
    });
    const lost = answering(() => new Response(null, { status: 409 }));
    expect(await lost.api.sendGroqChunk(GROQ_JOB, chunk)).toEqual({
      kind: 'lost',
    });
  });

  it('fails on any other answer, and completes the job with its chunks', async () => {
    const broken = answering(() => new Response('boom', { status: 503 }));
    await expect(broken.api.sendGroqChunk(GROQ_JOB, chunk)).rejects.toThrow(
      MediaApiError,
    );
    const done = answering(() => new Response(null, { status: 204 }));
    const raw = { chunks: [] };
    expect(
      await done.api.completeGroq(GROQ_JOB, {
        termsVersion: 3,
        vad: 'applied',
        speechRatio: 1,
        elapsedMs: 5,
        raw,
      }),
    ).toBe(true);
    expect(done.calls[0]?.url).toBe(
      `http://api:3000/api/v1/media-worker/jobs/${GROQ_JOB.id}/groq/transcript`,
    );
  });
});
