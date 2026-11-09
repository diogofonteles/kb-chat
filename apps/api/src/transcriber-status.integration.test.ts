import type {
  LocalTranscriberStart,
  TranscriberStatusOverview,
  TranscriberStatusReport,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOCAL,
  MEDIA_WORKER_TOKEN,
  caller,
  closeApp,
  signIn,
  start,
} from '../test/ai-app-harness.js';
import { member, startMedia, type Media } from '../test/media-harness.js';
import {
  asTranscriber,
  pair,
  readyForTranscription,
} from '../test/transcription-harness.js';
import { join } from 'node:path';
import type { LaunchctlRunner } from './adapters/media/launchctl-local-transcriber.js';

afterEach(async () => {
  vi.useRealTimers();
  await closeApp();
});

const STATUS = '/api/v1/media/transcribers/status';
const WORKER_STATUS = '/api/v1/media-worker/status';
const START = '/api/v1/media/transcribers/local/start';

const report = (
  over: Partial<TranscriberStatusReport> = {},
): TranscriberStatusReport => ({
  state: 'working',
  detail: null,
  version: '0.1.0 (2026-10-28.1)',
  kinds: ['transcribe', 'kb-publish'],
  startedAt: '2026-11-09T12:00:00.000Z',
  currentJob: {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'transcribe',
    label: 'Aula 3',
    startedAt: '2026-11-09T12:01:00.000Z',
    progress: 40,
  },
  recentJobs: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'kb-publish',
      label: 'publicando udv (3 documentos)',
      outcome: 'failed',
      finishedAt: '2026-11-09T11:59:00.000Z',
      detail: 'kb classify: OpenRouter 502',
    },
  ],
  lastError: {
    at: '2026-11-09T11:59:00.000Z',
    message: 'kb classify: OpenRouter 502',
  },
  counts: { done: 2, failed: 1 },
  vaultPath: '/Users/owner/dev/personal/hermetismo',
  kbVersion: '0.0.12',
  ...over,
});

const send = (media: Media, token: string, body: object) =>
  asTranscriber(media, token, {
    method: 'POST',
    url: WORKER_STATUS,
    payload: body,
  });

const overviewOf = async (media: Media) => {
  const read = await media.owner('GET', STATUS);
  expect(read.statusCode, read.body).toBe(200);
  return read.json<TranscriberStatusOverview>();
};

describe("The transcriber's status (KBC-114 AC-11, AC-12)", () => {
  it('keeps what a paired transcriber says and shows it to masters', async () => {
    const media = await startMedia();
    const { token, transcriber } = await pair(media);
    const sent = await send(media, token, report());
    expect(sent.statusCode, sent.body).toBe(204);

    const overview = await overviewOf(media);
    expect(overview.items).toHaveLength(1);
    expect(overview.items[0]).toMatchObject({
      id: transcriber.id,
      name: 'Mac do dono',
      state: 'working',
      report: {
        currentJob: { label: 'Aula 3', progress: 40 },
        lastError: { message: 'kb classify: OpenRouter 502' },
        vaultPath: '/Users/owner/dev/personal/hermetismo',
        kbVersion: '0.0.12',
      },
    });
    expect(overview.kbQueue).toEqual({ waiting: 0 });
    expect(overview.start).toEqual({
      label: 'br.com.nova-alexandria.transcriber',
      // Never a uv command (AC-17, QA F-5); a plain kickstart never kills a job.
      startCommand:
        'launchctl kickstart gui/$(id -u)/br.com.nova-alexandria.transcriber',
      canStartHere: false,
    });
    expect(JSON.stringify(overview)).not.toContain('uv run');
  });

  it('is off without a status, and off again when it stops saying for over 2 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T12:00:00.000Z'));
    const media = await startMedia();
    const { token } = await pair(media);
    expect((await overviewOf(media)).items[0]?.state).toBe('offline');
    await send(media, token, report({ state: 'idle', currentJob: null }));
    expect((await overviewOf(media)).items[0]?.state).toBe('idle');
    vi.setSystemTime(new Date('2026-11-09T12:03:00.000Z'));
    const stale = (await overviewOf(media)).items[0];
    expect(stale?.state).toBe('offline');
    // The last thing it said stays to be read in the details.
    expect(stale?.report?.state).toBe('idle');
  });

  it('refuses the VM token (403), no token (401) and a body outside the contract (400)', async () => {
    const media = await startMedia();
    const { token } = await pair(media);
    expect((await send(media, MEDIA_WORKER_TOKEN, report())).statusCode).toBe(
      403,
    );
    const anonymous = await media.started.app.inject({
      method: 'POST',
      url: WORKER_STATUS,
      headers: LOCAL,
      payload: report(),
    });
    expect(anonymous.statusCode).toBe(401);
    expect(
      (await send(media, token, { ...report(), state: 'sleeping' })).statusCode,
    ).toBe(400);
    expect(
      (await send(media, token, { ...report(), token: 'nat_x' })).statusCode,
    ).toBe(400);
  });

  it('forgets a revoked transcriber, whose token then says nothing more (401)', async () => {
    const media = await startMedia();
    const { token, transcriber } = await pair(media);
    await send(media, token, report());
    const revoked = await media.owner(
      'DELETE',
      `/api/v1/media/transcribers/${transcriber.id}`,
    );
    expect(revoked.statusCode).toBe(204);
    expect((await overviewOf(media)).items).toEqual([]);
    expect((await send(media, token, report())).statusCode).toBe(401);
  });

  it('is for masters only: 401 without a session, 403 to a member', async () => {
    const media = await startMedia();
    const anonymous = await media.started.app.inject({
      method: 'GET',
      url: STATUS,
      headers: LOCAL,
    });
    expect(anonymous.statusCode).toBe(401);
    const { call } = await member(media, {
      email: 'membro@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-edit', 'media-tracks'],
    });
    expect((await call('GET', STATUS)).statusCode).toBe(403);
  });
});

describe('"Ligar transcritor" on the same Mac (KBC-114 AC-13)', () => {
  const fakeLaunchctl = (code = 0, output = '') => {
    const calls: (readonly string[])[] = [];
    const run: LaunchctlRunner = (args) => {
      calls.push(args);
      return Promise.resolve({ code, output });
    };
    return { calls, run };
  };

  it('does not exist without KB_CHAT_LOCAL_TRANSCRIBER (404), and the overview says so', async () => {
    const media = await startMedia();
    expect((await media.owner('POST', START)).statusCode).toBe(404);
    expect((await overviewOf(media)).start.canStartHere).toBe(false);
  });

  it('runs launchctl kickstart on the fixed label, and only for masters', async () => {
    const launchctl = fakeLaunchctl();
    const started = await start({
      media: true,
      env: { KB_CHAT_LOCAL_TRANSCRIBER: '1' },
      launchctl: launchctl.run,
    });
    const owner = caller(
      started.app,
      await signIn(started, 'owner@example.com'),
    );
    const read = await owner('GET', STATUS);
    expect(read.json<TranscriberStatusOverview>().start.canStartHere).toBe(
      true,
    );

    const done = await owner('POST', START);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json<LocalTranscriberStart>()).toEqual({
      ok: true,
      detail: 'transcriber started',
    });
    expect(launchctl.calls).toHaveLength(1);
    expect(launchctl.calls[0]?.slice(0, 2)).toEqual(['kickstart', '-k']);
    expect(launchctl.calls[0]?.[2]).toMatch(
      /^gui\/\d+\/br\.com\.nova-alexandria\.transcriber$/,
    );

    const anonymous = await started.app.inject({
      method: 'POST',
      url: START,
      headers: LOCAL,
    });
    expect(anonymous.statusCode).toBe(401);
    expect(launchctl.calls).toHaveLength(1);
  });

  it('says what launchctl answered when the service is not installed', async () => {
    const launchctl = fakeLaunchctl(113, 'Could not find service');
    const started = await start({
      media: true,
      env: { KB_CHAT_LOCAL_TRANSCRIBER: '1' },
      launchctl: launchctl.run,
    });
    const owner = caller(
      started.app,
      await signIn(started, 'owner@example.com'),
    );
    const done = await owner('POST', START);
    expect(done.statusCode).toBe(200);
    expect(done.json<LocalTranscriberStart>()).toEqual({
      ok: false,
      detail: 'Could not find service',
    });
  });
});

describe('The transcriber starts by itself on the same Mac (KBC-114 AC-15)', () => {
  /** The media library on a Mac whose launchctl only records what it is asked. */
  async function onTheMac() {
    const calls: (readonly string[])[] = [];
    const run: LaunchctlRunner = (args) => {
      calls.push(args);
      return Promise.resolve({ code: 0, output: '' });
    };
    const started = await start({
      media: true,
      env: { KB_CHAT_LOCAL_TRANSCRIBER: '1' },
      launchctl: run,
    });
    const ownerHeaders = await signIn(started, 'owner@example.com');
    const media: Media = {
      started,
      owner: caller(started.app, ownerHeaders),
      ownerHeaders,
      mediaDir: join(started.state, 'media'),
    };
    return { media, calls };
  }

  it('an upload converted and waiting for its transcription starts it, without -k, once', async () => {
    const { media, calls } = await onTheMac();
    await pair(media);
    await readyForTranscription(media);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual([
      'kickstart',
      expect.stringMatching(
        /^gui\/\d+\/br\.com\.nova-alexandria\.transcriber$/,
      ),
    ]);
    // Another upload within the minute: launchd is not asked again.
    await readyForTranscription(media);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(1);
  });

  it('a transcriber that is on is left alone', async () => {
    const { media, calls } = await onTheMac();
    const { token } = await pair(media);
    expect(
      (await send(media, token, report({ state: 'idle', currentJob: null })))
        .statusCode,
    ).toBe(204);
    await readyForTranscription(media);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toEqual([]);
  });

  it('a transcriber that exited when idle is started again for the next audio (AC-18)', async () => {
    const { media, calls } = await onTheMac();
    const { token } = await pair(media);
    const stopped = await send(
      media,
      token,
      report({ state: 'stopped', currentJob: null }),
    );
    expect(stopped.statusCode).toBe(204);
    await readyForTranscription(media);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
  });

  it('QA F-1: a transcription no paired transcriber takes starts nothing, and the app says why', async () => {
    const { media, calls } = await onTheMac();
    const { transcriber } = await pair(media);
    // Only "Publica no acervo" marked: the transcription can never be leased by it.
    const marked = await media.owner(
      'PATCH',
      `/api/v1/media/transcribers/${transcriber.id}`,
      { kinds: ['kb-publish'] },
    );
    expect(marked.statusCode).toBe(200);
    await readyForTranscription(media);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toEqual([]);
    expect((await overviewOf(media)).attention).toEqual({
      blocked: [{ kind: 'transcribe', ready: 1 }],
      stuck: null,
    });
  });

  it('QA F-1: a launch that took nothing is not repeated while the queue is the same', async () => {
    const { media, calls } = await onTheMac();
    const { token } = await pair(media);
    await readyForTranscription(media);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // It ran and, say, its Whisper could not load: it took nothing and exited.
    const stopped = await send(
      media,
      token,
      report({ state: 'stopped', currentJob: null, kinds: ['transcribe'] }),
    );
    expect(stopped.statusCode).toBe(204);
    // Another change in the media library: the waker looks again, and does not relaunch.
    await media.owner('POST', '/api/v1/media/transcribers', { name: 'Outro' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(1);
    expect((await overviewOf(media)).attention.stuck).toEqual({ ready: 1 });
  });

  it('QA F-2: "Ligar transcritor" never kills a transcriber that is on, and counts once per 30 s', async () => {
    const { media, calls } = await onTheMac();
    const { token } = await pair(media);
    await send(media, token, report({ state: 'working' }));
    const first = await media.owner('POST', START);
    const second = await media.owner('POST', START);
    expect(first.statusCode).toBe(200);
    expect(second.json<LocalTranscriberStart>().detail).toBe(
      'already asked a moment ago',
    );
    const asked = calls.filter((args) => args[0] === 'kickstart');
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toContain('-k');
  });

  it('without KB_CHAT_LOCAL_TRANSCRIBER (production) nothing is ever started', async () => {
    const media = await startMedia();
    await readyForTranscription(media);
    // The real launchctl of the harness refuses: had it been asked, the log would say so.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      media.started.logs.some((line) => line.includes('could not start')),
    ).toBe(false);
  });
});
