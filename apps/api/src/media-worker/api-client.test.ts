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
      kinds: ['transcode', 'silences'],
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
