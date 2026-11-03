import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { TranscribeJob } from '@kb-chat/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsMediaFiles } from './adapters/media/fs-media-files.js';
import { openMediaDatabase } from './adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from './adapters/sqlite/media-migrations.js';
import { SqliteMediaStore } from './adapters/sqlite/sqlite-media-store.js';
import { SqliteTranscriptStore } from './adapters/sqlite/sqlite-transcript-store.js';
import { createLogger } from './logger.js';
import {
  JOB_LEASE_MS,
  MediaJanitor,
  TranscriptionService,
  WorkerService,
} from './modules/media/index.js';
import { pilotRaw } from '../test/transcript-fixtures.js';

const T0 = new Date('2026-11-03T12:00:00.000Z');
const MEDIA_ID = '22222222-2222-4222-8222-222222222222';
let dir: string;
let clock: Date;
let store: SqliteMediaStore;
let transcripts: SqliteTranscriptStore;
let files: FsMediaFiles;

const now = () => clock;
const workers = () => new WorkerService({ store, files, now });
const transcription = () =>
  new TranscriptionService({ store, transcripts, files, now });

/** An item converted by the VM: ready, with its transcription queued. */
async function readyItem(): Promise<void> {
  store.createMedia({
    id: MEDIA_ID,
    topic: 'hermetismo',
    title: 'Palestra',
    authorship: 'mestre-laercio',
    ownerPrincipal: 'owner',
    fileName: 'a.mp3',
    uploadBytes: 3,
    now: clock,
  });
  await files.saveUpload({
    mediaId: MEDIA_ID,
    body: Readable.from([Buffer.from('abc')]),
    expectedBytes: 3,
  });
  store.markUploaded({
    mediaId: MEDIA_ID,
    jobId: crypto.randomUUID(),
    now: clock,
  });
  const job = workers().lease({ worker: 'vm', kinds: ['transcode'] });
  if (job?.kind !== 'transcode') throw new Error('no conversion');
  await files.writeFile(job.targetPath, 'aac');
  await workers().completeTranscode(job.id, {
    worker: 'vm',
    leaseId: job.leaseId,
    durationMs: 600_000,
    bytes: 3,
  });
}

function leaseFor(worker: string): TranscribeJob {
  const job = workers().lease({ worker, kinds: ['transcribe'] });
  if (job?.kind !== 'transcribe') throw new Error('no transcription');
  return job;
}

const complete = (job: TranscribeJob, worker: string) =>
  transcription().complete(
    { jobId: job.id, leaseId: job.leaseId, worker },
    {
      worker,
      leaseId: job.leaseId,
      provider: 'mlx-whisper',
      model: 'mlx-community/whisper-large-v3-turbo',
      parametersVersion: '2026-10-28.1',
      parameters: {},
      termsVersion: 1,
      vad: 'applied',
      speechRatio: 0.9,
      elapsedMs: 100,
      raw: pilotRaw('clean-cd02-01'),
    },
  );

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kbchat-transcribe-'));
  clock = T0;
  const db = openMediaDatabase(':memory:', MEDIA_MIGRATIONS);
  store = new SqliteMediaStore(db);
  transcripts = new SqliteTranscriptStore(db);
  files = new FsMediaFiles(dir);
  await files.assertWritable();
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('A transcription whose Mac stopped (KBC-036 AC-8)', () => {
  it('goes back to the queue when the lease expires and is stored once', async () => {
    await readyItem();
    const lost = leaseFor('transcriber:mac-1');
    clock = new Date(T0.getTime() + JOB_LEASE_MS + 1);
    const janitor = new MediaJanitor({
      store,
      files,
      log: createLogger('silent'),
      now,
    });
    expect(await janitor.sweep()).toMatchObject({ requeued: 1, failed: 0 });
    // The item stays playable while its transcription waits again.
    expect(store.getMedia(MEDIA_ID)).toMatchObject({
      status: 'ready',
      transcription: { jobStatus: 'queued', version: null },
    });
    const retaken = leaseFor('transcriber:mac-2');
    expect(retaken.attempt).toBe(2);
    await complete(retaken, 'transcriber:mac-2');
    // The first Mac wakes up and sends its late result: refused, nothing stored twice.
    await expect(complete(lost, 'transcriber:mac-1')).rejects.toMatchObject({
      code: 'MEDIA_CONFLICT',
    });
    expect(transcripts.transcripts(MEDIA_ID)).toHaveLength(1);
    expect(store.getMedia(MEDIA_ID)?.transcription).toMatchObject({
      jobStatus: 'done',
      version: 1,
      confidence: 'normal',
    });
  });

  it('gives a transcription up after the last attempt, leaving the item ready', async () => {
    await readyItem();
    await files.writeFile(files.flacPath(MEDIA_ID), 'fLaC');
    const janitor = new MediaJanitor({
      store,
      files,
      log: createLogger('silent'),
      now,
    });
    for (let attempt = 1; attempt <= 4; attempt++) {
      leaseFor('transcriber:mac');
      clock = new Date(clock.getTime() + JOB_LEASE_MS + 1);
      await janitor.sweep();
    }
    expect(store.getMedia(MEDIA_ID)).toMatchObject({
      status: 'ready',
      failure: null,
      transcription: { jobStatus: 'dead' },
    });
    // Nothing will use its FLAC now: the janitor drops it.
    expect(await files.stat(files.flacPath(MEDIA_ID))).toBeNull();
  });

  it('stores the derived segments and words of the newest version', async () => {
    await readyItem();
    await complete(leaseFor('transcriber:mac'), 'transcriber:mac');
    const [current] = transcripts.transcripts(MEDIA_ID);
    expect(current).toMatchObject({
      version: 1,
      vad: 'applied',
      filterVersion: 1,
      confidenceVersion: 1,
    });
    const segments = transcripts.segments(current?.id ?? '');
    const words = transcripts.words(current?.id ?? '');
    expect(segments.length).toBeGreaterThan(3);
    expect(words).toHaveLength(current?.wordCount ?? -1);
    expect(words[0]).toMatchObject({ segment: 0, text: expect.any(String) });
    expect(segments[0]?.avgLogprob).toEqual(expect.any(Number));
  });
});
