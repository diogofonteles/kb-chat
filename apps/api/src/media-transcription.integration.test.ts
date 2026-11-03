import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MediaItem, Transcriber } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import {
  convert,
  leaseJob,
  member,
  queuedItem,
  readyItem,
  startMedia,
  worker,
  type Media,
} from '../test/media-harness.js';
import {
  FLAC,
  asTranscriber,
  leaseTranscription,
  pair,
  readyForTranscription,
  sendTranscript,
} from '../test/transcription-harness.js';
import { pilotRaw } from '../test/transcript-fixtures.js';

afterEach(closeApp);

const itemOf = async (media: Media, id: string): Promise<MediaItem> =>
  (await media.owner('GET', `/api/v1/media/${id}`)).json();

describe('Transcribers: pairing (KBC-036 FR-5, BR-1)', () => {
  it('pairs a transcriber, shows its token once and lists it', async () => {
    const media = await startMedia();
    const paired = await pair(media, 'Mac do dono');
    expect(paired.token).toMatch(/^nat_[\w-]{40,}$/);
    expect(paired.transcriber).toMatchObject({
      name: 'Mac do dono',
      kinds: ['transcribe'],
      lastSeenAt: null,
      online: false,
      currentJob: null,
    });
    const listed = await media.owner('GET', '/api/v1/media/transcribers');
    expect(listed.json().items).toEqual([paired.transcriber]);
    expect(JSON.stringify(listed.json())).not.toContain(paired.token);
  });

  it('keeps only a keyed hash of the token in the database', async () => {
    const media = await startMedia();
    const { token } = await pair(media);
    const db = readFileSync(join(media.mediaDir, 'media.db'));
    expect(db.includes(Buffer.from(token))).toBe(false);
  });

  it('refuses a blank name', async () => {
    const media = await startMedia();
    const refused = await media.owner('POST', '/api/v1/media/transcribers', {
      name: '   ',
    });
    expect(refused.statusCode).toBe(400);
  });

  it('refuses the screen to a member (AC-7)', async () => {
    const media = await startMedia();
    const { call } = await member(media, {
      email: 'aluno@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-upload'],
    });
    expect((await call('GET', '/api/v1/media/transcribers')).statusCode).toBe(
      403,
    );
    const paired = await call('POST', '/api/v1/media/transcribers', {
      name: 'Meu Mac',
    });
    expect(paired.statusCode).toBe(403);
  });

  it('revokes a transcriber: its token gets 401 and its job goes back to the queue (AC-6)', async () => {
    const media = await startMedia();
    const { token, transcriber } = await pair(media);
    const item = await readyForTranscription(media);
    await leaseTranscription(media, token);
    expect((await itemOf(media, item.id)).transcription.status).toBe(
      'transcribing',
    );
    const revoked = await media.owner(
      'DELETE',
      `/api/v1/media/transcribers/${transcriber.id}`,
    );
    expect(revoked.statusCode).toBe(204);
    const lease = await asTranscriber(media, token, {
      method: 'POST',
      url: '/api/v1/media-worker/jobs/lease',
      payload: { worker: 'mac', kinds: ['transcribe'] },
    });
    expect(lease.statusCode).toBe(401);
    expect((await itemOf(media, item.id)).transcription.status).toBe(
      'waiting',
    );
    const listed = await media.owner('GET', '/api/v1/media/transcribers');
    expect(listed.json().items).toEqual([]);
    const again = await media.owner(
      'DELETE',
      `/api/v1/media/transcribers/${transcriber.id}`,
    );
    expect(again.statusCode).toBe(404);
  });
});

describe('Transcription: the worker protocol (KBC-036)', () => {
  it('queues a transcription when an item becomes ready and transcribes it (AC-1)', async () => {
    const media = await startMedia();
    const { token, transcriber } = await pair(media);
    const item = await readyForTranscription(media);
    expect((await itemOf(media, item.id)).transcription).toMatchObject({
      status: 'waiting',
      confidence: null,
      version: null,
    });
    const job = await leaseTranscription(media, token);
    expect(job).toMatchObject({
      kind: 'transcribe',
      mediaId: item.id,
      durationMs: 180_000,
      audioPath: `/api/v1/media-worker/jobs/${job.id}/audio`,
    });
    const listed = await media.owner('GET', '/api/v1/media/transcribers');
    expect(listed.json().items[0]).toMatchObject({
      id: transcriber.id,
      online: true,
      currentJob: { mediaId: item.id, title: 'Palestra de 1998' },
    });
    expect((await itemOf(media, item.id)).transcription.status).toBe(
      'transcribing',
    );
    const audio = await asTranscriber(media, token, {
      method: 'GET',
      url: `${job.audioPath}?leaseId=${job.leaseId}`,
    });
    expect(audio.statusCode).toBe(200);
    expect(audio.headers['content-type']).toBe('audio/flac');
    expect(audio.rawPayload).toEqual(FLAC);
    const sent = await sendTranscript(media, { token, job });
    expect(sent.statusCode).toBe(204);
    const done = await itemOf(media, item.id);
    expect(done.status).toBe('ready');
    expect(done.transcription).toMatchObject({
      status: 'done',
      confidence: 'normal',
      version: 1,
    });
    // ADR 0022 §4: the FLAC goes once the transcript is stored; the raw JSON stays.
    expect(existsSync(join(media.mediaDir, 'audio', `${item.id}.flac`))).toBe(
      false,
    );
    const raws = readdirSync(join(media.mediaDir, 'transcripts', item.id));
    expect(raws).toHaveLength(1);
    const raw = JSON.parse(
      readFileSync(
        join(media.mediaDir, 'transcripts', item.id, raws[0] ?? ''),
        'utf8',
      ),
    );
    expect(raw).toMatchObject({ termsVersion: 1, vad: 'applied' });
    expect(raw.raw.chunks).toHaveLength(4);
  });

  it('serves the term list v1 with the pilot terms', async () => {
    const media = await startMedia();
    const { token } = await pair(media);
    const terms = await asTranscriber(media, token, {
      method: 'GET',
      url: '/api/v1/media-worker/terms',
    });
    expect(terms.statusCode).toBe(200);
    expect(terms.json().version).toBe(1);
    expect(terms.json().terms).toHaveLength(32);
    expect(terms.json().terms).toContain('Tiuaco');
  });

  it('marks a noisy recording low confidence (AC-5, BR-5)', async () => {
    const media = await startMedia();
    const { token } = await pair(media);
    const item = await readyForTranscription(media);
    const job = await leaseTranscription(media, token);
    const sent = await sendTranscript(media, {
      token,
      job,
      raw: pilotRaw('noisy-cd03-06'),
    });
    expect(sent.statusCode).toBe(204);
    const done = await itemOf(media, item.id);
    expect(done.transcription).toMatchObject({
      status: 'done',
      confidence: 'low',
    });
    // Still playable (BR-5).
    const stream = await media.owner('GET', `/api/v1/media/${item.id}/stream`);
    expect(stream.statusCode).toBe(200);
  });

  it('serves the audio rendition when there is no FLAC (items converted before)', async () => {
    const media = await startMedia();
    const { token } = await pair(media);
    await readyItem(media);
    const job = await leaseTranscription(media, token);
    const audio = await asTranscriber(media, token, {
      method: 'GET',
      url: `${job.audioPath}?leaseId=${job.leaseId}`,
    });
    expect(audio.statusCode).toBe(200);
    expect(audio.headers['content-type']).toBe('audio/mp4');
  });

  it('answers 401 to an unknown token and 404 for the audio of a job it does not hold (AC-6)', async () => {
    const media = await startMedia();
    const first = await pair(media, 'Mac 1');
    const second = await pair(media, 'Mac 2');
    await readyForTranscription(media);
    const job = await leaseTranscription(media, first.token);
    const unknown = await asTranscriber(media, 'nat_not-a-real-token', {
      method: 'GET',
      url: '/api/v1/media-worker/terms',
    });
    expect(unknown.statusCode).toBe(401);
    const theirs = await asTranscriber(media, second.token, {
      method: 'GET',
      url: `${job.audioPath}?leaseId=${job.leaseId}`,
    });
    expect(theirs.statusCode).toBe(404);
    const posing = await sendTranscript(media, { token: second.token, job });
    expect(posing.statusCode).toBe(409);
  });

  it('keeps each token to its kinds: no conversions for a transcriber, no transcriptions for the VM', async () => {
    const media = await startMedia();
    const { token } = await pair(media);
    await queuedItem(media);
    const asked = await asTranscriber(media, token, {
      method: 'POST',
      url: '/api/v1/media-worker/jobs/lease',
      payload: { worker: 'mac', kinds: ['transcode'] },
    });
    expect(asked.statusCode).toBe(403);
    await convert(media, await leaseJob(media));
    const vm = await worker(media, '/api/v1/media-worker/jobs/lease', {
      worker: 'vm',
      kinds: ['transcribe'],
    });
    expect(vm.statusCode).toBe(403);
  });

  it('answers 204 when nothing waits', async () => {
    const media = await startMedia();
    const { token } = await pair(media);
    const idle = await asTranscriber(media, token, {
      method: 'POST',
      url: '/api/v1/media-worker/jobs/lease',
      payload: { worker: 'mac', kinds: ['transcribe'] },
    });
    expect(idle.statusCode).toBe(204);
  });

  it('beats and fails a transcription without touching the playable item', async () => {
    const media = await startMedia();
    const { token } = await pair(media);
    const item = await readyForTranscription(media);
    const job = await leaseTranscription(media, token);
    const beat = await asTranscriber(media, token, {
      method: 'POST',
      url: `/api/v1/media-worker/jobs/${job.id}/heartbeat`,
      payload: { worker: 'mac', leaseId: job.leaseId, progress: 40 },
    });
    expect(beat.statusCode).toBe(204);
    expect(await itemOf(media, item.id)).toMatchObject({
      status: 'ready',
      progress: null,
    });
    const failed = await asTranscriber(media, token, {
      method: 'POST',
      url: `/api/v1/media-worker/jobs/${job.id}/fail`,
      payload: {
        worker: 'mac',
        leaseId: job.leaseId,
        failure: 'invalid-audio',
        detail: 'ffmpeg could not decode',
      },
    });
    expect(failed.statusCode).toBe(204);
    const after = await itemOf(media, item.id);
    expect(after.status).toBe('ready');
    expect(after.transcription.status).toBe('failed');
  });

  it('keeps every version and makes the newest current when transcribed again (AC-9, BR-3)', async () => {
    const media = await startMedia();
    const { token } = await pair(media);
    const item = await readyForTranscription(media);
    const first = await leaseTranscription(media, token);
    await sendTranscript(media, {
      token,
      job: first,
      raw: pilotRaw('noisy-cd03-05'),
    });
    const again = await media.owner(
      'POST',
      `/api/v1/media/${item.id}/transcription`,
    );
    expect(again.statusCode).toBe(200);
    expect(again.json().transcription).toMatchObject({
      status: 'waiting',
      version: 1,
      confidence: 'low',
    });
    const twice = await media.owner(
      'POST',
      `/api/v1/media/${item.id}/transcription`,
    );
    expect(twice.statusCode).toBe(409);
    const second = await leaseTranscription(media, token);
    // The FLAC went with the first transcript: the rendition is served now.
    const audio = await asTranscriber(media, token, {
      method: 'GET',
      url: `${second.audioPath}?leaseId=${second.leaseId}`,
    });
    expect(audio.headers['content-type']).toBe('audio/mp4');
    await sendTranscript(media, { token, job: second });
    expect((await itemOf(media, item.id)).transcription).toMatchObject({
      status: 'done',
      version: 2,
      confidence: 'normal',
    });
    expect(
      readdirSync(join(media.mediaDir, 'transcripts', item.id)),
    ).toHaveLength(2);
  });

  it('removes the raw transcripts with the item', async () => {
    const media = await startMedia();
    const { token } = await pair(media);
    const item = await readyForTranscription(media);
    await sendTranscript(media, {
      token,
      job: await leaseTranscription(media, token),
    });
    const removed = await media.owner('DELETE', `/api/v1/media/${item.id}`);
    expect(removed.statusCode).toBe(204);
    expect(existsSync(join(media.mediaDir, 'transcripts', item.id))).toBe(
      false,
    );
  });
});

describe('Transcription: the transcriber presence on the item (KBC-036 FR-1)', () => {
  it('says no transcriber is paired, then that one is on', async () => {
    const media = await startMedia();
    const item = await readyForTranscription(media);
    expect((await itemOf(media, item.id)).transcription).toMatchObject({
      status: 'waiting',
      transcriber: 'none',
      transcriberOffSince: null,
    });
    const paired = await pair(media);
    const off = (await itemOf(media, item.id)).transcription;
    expect(off.transcriber).toBe('off');
    expect(off.transcriberOffSince).toBe(paired.transcriber.createdAt);
    await asTranscriber(media, paired.token, {
      method: 'GET',
      url: '/api/v1/media-worker/terms',
    });
    expect((await itemOf(media, item.id)).transcription).toMatchObject({
      transcriber: 'on',
      transcriberOffSince: null,
    });
  });

  it('lists the transcriber state to a member who listens', async () => {
    const media = await startMedia();
    const item = await readyForTranscription(media);
    const { call } = await member(media, {
      email: 'ouvinte@example.com',
      topics: ['hermetismo'],
      features: ['media'],
    });
    const listed = await call('GET', '/api/v1/topics/hermetismo/media');
    const found = listed
      .json()
      .items.find((one: MediaItem) => one.id === item.id);
    expect(found.transcription.status).toBe('waiting');
    const again = await call('POST', `/api/v1/media/${item.id}/transcription`);
    expect(again.statusCode).toBe(403);
  });

  it('refuses to transcribe again an item that is not ready', async () => {
    const media = await startMedia();
    const item = await queuedItem(media);
    const again = await media.owner(
      'POST',
      `/api/v1/media/${item.id}/transcription`,
    );
    expect(again.statusCode).toBe(409);
  });

  it('shows the transcriber list sorted with the online flag', async () => {
    const media = await startMedia();
    await pair(media, 'Mac 1');
    await pair(media, 'Mac 2');
    const items: Transcriber[] = (
      await media.owner('GET', '/api/v1/media/transcribers')
    ).json().items;
    expect(items.map((one) => [one.name, one.online])).toEqual([
      ['Mac 1', false],
      ['Mac 2', false],
    ]);
  });
});
