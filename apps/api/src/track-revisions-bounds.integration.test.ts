import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CutJob,
  MediaBookmark,
  MediaItem,
  MediaTranscript,
  MovedBookmarks,
  TrackEditView,
  WorkerJob,
} from '@kb-chat/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import { ffmpegBins } from '../test/media-tools.js';
import {
  leaseJob,
  queuedItem,
  worker,
  type Media,
} from '../test/media-harness.js';
import {
  approve,
  leaseCut,
  libraryEntry,
  say,
  startWorld,
  type World,
} from '../test/track-items-harness.js';
import { FLAC } from '../test/transcription-harness.js';
import {
  AUDIO_RENDITION_ARGS,
  cutAudio,
  probe,
} from './media-worker/ffmpeg.js';

const bins = ffmpegBins();
const RECORDING_S = 20 * 60;
/** How far a stream copy may land from what was asked (KBC-068 NFR-3). */
const LIMIT_MS = 50;
/** NFR-2: a track of 10 min ready again, on one CPU. */
const READY_LIMIT_MS = 15_000;

const urlOf = (id: string) => `/api/v1/media/${id}`;

/** The conversion, for real: a rendition the cuts can copy from. */
async function convertForReal(media: Media, job: WorkerJob): Promise<void> {
  const target = join(media.mediaDir, job.targetPath);
  execFileSync(bins.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `anoisesrc=color=pink:duration=${RECORDING_S}:sample_rate=44100:amplitude=0.2`,
    ...AUDIO_RENDITION_ARGS,
    target,
  ]);
  if (job.flacTargetPath)
    writeFileSync(join(media.mediaDir, job.flacTargetPath), FLAC);
  const { durationMs } = await probe(bins, target);
  const done = await worker(
    media,
    `/api/v1/media-worker/jobs/${job.id}/complete`,
    {
      worker: 'vm',
      leaseId: job.leaseId,
      durationMs,
      bytes: statSync(target).size,
      flacBytes: FLAC.length,
    },
  );
  expect(done.statusCode, done.body).toBe(204);
}

/** What the worker does with a cut job: ffmpeg, the probe, the report. */
async function cutForReal(media: Media, job: CutJob): Promise<void> {
  const target = join(media.mediaDir, job.targetPath);
  const source = join(media.mediaDir, job.sourcePath);
  const { startMs, endMs } = job;
  await cutAudio({ bins, source, target, startMs, endMs });
  const { durationMs } = await probe(bins, target);
  const done = await worker(media, `/api/v1/media-worker/jobs/${job.id}/cut`, {
    worker: 'vm',
    leaseId: job.leaseId,
    bytes: statSync(target).size,
    durationMs,
  });
  expect(done.statusCode, done.body).toBe(204);
}

async function cutAllForReal(media: Media): Promise<void> {
  for (
    let job = await leaseCut(media);
    job !== null;
    job = await leaseCut(media)
  )
    await cutForReal(media, job);
}

const viewOf = async (media: Media, id: string) =>
  (await media.owner('GET', `${urlOf(id)}/track-edit`)).json<TrackEditView>();

const itemOf = async (media: Media, id: string) =>
  (await media.owner('GET', urlOf(id))).json<MediaItem>();

/** The file behind `stream`, as ffprobe reads it. */
async function durationOf(media: Media, url: string) {
  const answer = await media.owner('GET', url);
  expect(answer.statusCode, answer.body.slice(0, 200)).toBe(200);
  const path = join(media.mediaDir, 'probe-stream.m4a');
  writeFileSync(path, answer.rawPayload);
  return (await probe(bins, path)).durationMs;
}

// The rendition takes seconds to make; the limit under test is on what follows it.
describe(
  'New bounds, cut by real ffmpeg (KBC-073)',
  { timeout: 120_000 },
  () => {
    let world: World;
    let trackId = '';
    let recordingId = '';
    let bookmarkId = '';
    let readyInMs = 0;

    beforeAll(async () => {
      world = await startWorld();
      const { media } = world;
      const recording = await queuedItem(media);
      recordingId = recording.id;
      await convertForReal(media, await leaseJob(media));
      await say(world, [
        { at: 10, text: 'abertura antes do novo início' },
        { at: 300, text: 'hoasca no meio da faixa' },
      ]);
      await approve(media, recording.id, [
        { startMs: 0, endMs: 600_000, title: 'Dez minutos' },
        { startMs: 600_000, endMs: 1_200_000, title: 'A vizinha' },
      ]);
      await cutAllForReal(media);
      const entry = await libraryEntry(media.owner, recording.id);
      trackId = entry?.tracks[0]?.id ?? '';
      expect(trackId).not.toBe('');

      const saved = await media.owner('PUT', `${urlOf(trackId)}/progress`, {
        positionMs: 90_000,
        basedOn: null,
      });
      expect(saved.statusCode, saved.body).toBe(200);
      bookmarkId = randomUUID();
      const marked = await media.owner('POST', `${urlOf(trackId)}/bookmarks`, {
        id: bookmarkId,
        positionMs: 590_000,
      });
      expect(marked.statusCode, marked.body).toBe(201);

      const { version } = await viewOf(media, trackId);
      const started = performance.now();
      const moved = await media.started.app.inject({
        method: 'PUT',
        url: `${urlOf(trackId)}/bounds`,
        headers: { ...media.ownerHeaders, 'if-match': `"${version}"` },
        payload: { startMs: 30_000, endMs: 570_000 },
      });
      expect(moved.statusCode, moved.body).toBe(202);
      await cutAllForReal(media);
      readyInMs = performance.now() - started;
    }, 120_000);

    afterAll(closeApp);

    it('NFR-2: a 10 min track is ready again within 15 s, cut, text and remap', async () => {
      expect((await viewOf(world.media, trackId)).cut).toBe('none');
      expect(readyInMs).toBeLessThan(READY_LIMIT_MS);
    });

    it('AC-4: the file is the new bounds, within 50 ms', async () => {
      const item = await itemOf(world.media, trackId);
      expect(item.id).toBe(trackId);
      expect(item.parent?.startMs).toBe(30_000);
      expect(Math.abs((item.durationMs ?? 0) - 540_000)).toBeLessThanOrEqual(
        LIMIT_MS,
      );
      const onDisk = await durationOf(world.media, `${urlOf(trackId)}/stream`);
      expect(Math.abs(onDisk - 540_000)).toBeLessThanOrEqual(LIMIT_MS);
    });

    it('AC-4: the position follows the absolute time', async () => {
      const item = await itemOf(world.media, trackId);
      expect(Math.abs((item.positionMs ?? 0) - 60_000)).toBeLessThanOrEqual(
        LIMIT_MS,
      );
    });

    it('AC-4: a bookmark past the new end leaves for the recording, and its owner is told', async () => {
      const { media } = world;
      const onRecording = await media.owner(
        'GET',
        `${urlOf(recordingId)}/bookmarks`,
      );
      const moved = onRecording
        .json<{ items: MediaBookmark[] }>()
        .items.find((one) => one.id === bookmarkId);
      expect(moved?.positionMs).toBe(590_000);
      const notice = await media.owner('GET', '/api/v1/media/bookmarks/moved');
      expect(notice.json<MovedBookmarks>().moved).toEqual([
        {
          mediaId: trackId,
          recordingId,
          title: 'Dez minutos',
          count: 1,
        },
      ]);
    });

    it('AC-4: the text starts at the new start', async () => {
      const { media } = world;
      const read = await media.owner('GET', `${urlOf(trackId)}/transcript`);
      const body = read.json<MediaTranscript>();
      expect(read.body).toContain('hoasca');
      expect(read.body).not.toContain('abertura');
      // Said at 5:00 of the recording, 30 s after the old start of this file.
      expect(Math.abs((body.segments[0]?.startMs ?? 0) - 270_000)).toBeLessThan(
        1_000,
      );
    });

    it('AC-5: who is on the old cut keeps the old file, whole', async () => {
      const { media } = world;
      const { parent } = await itemOf(media, trackId);
      expect(parent?.fileVersion).toBe(2);
      const old = await durationOf(media, `${urlOf(trackId)}/stream?v=1`);
      expect(Math.abs(old - 600_000)).toBeLessThanOrEqual(LIMIT_MS);
    });
  },
);
