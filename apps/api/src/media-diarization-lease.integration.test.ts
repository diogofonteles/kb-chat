import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import type { DiarizeJob, TranscribeJob } from '@kb-chat/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsMediaFiles } from './adapters/media/fs-media-files.js';
import { openMediaDatabase } from './adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from './adapters/sqlite/media-migrations.js';
import { SqliteDiarizationStore } from './adapters/sqlite/sqlite-diarization-store.js';
import { SqliteVoiceLabelStore } from './adapters/sqlite/sqlite-speaker-store.js';
import { SqliteMediaStore } from './adapters/sqlite/sqlite-media-store.js';
import { SqliteTranscriptStore } from './adapters/sqlite/sqlite-transcript-store.js';
import { createLogger } from './logger.js';
import {
  DiarizationService,
  JOB_LEASE_MS,
  MediaJanitor,
  TranscriptionService,
  WorkerService,
} from './modules/media/index.js';
import {
  CONVERSATION_TURNS,
  conversationRaw,
} from '../test/diarization-harness.js';

const T0 = new Date('2026-11-03T12:00:00.000Z');
const MEDIA_ID = '22222222-2222-4222-8222-222222222222';
let dir: string;
let clock: Date;
let store: SqliteMediaStore;
let transcripts: SqliteTranscriptStore;
let diarizations: SqliteDiarizationStore;
let files: FsMediaFiles;
let database: DatabaseSync;
const openDb = () => database;

const now = () => clock;
const workers = () => new WorkerService({ store, files, now });
const diarization = () =>
  new DiarizationService({
    store,
    transcripts,
    diarizations,
    voiceLabels: new SqliteVoiceLabelStore(database),
    files,
    now,
  });
const janitor = () =>
  new MediaJanitor({ store, files, log: createLogger('silent'), now });

/** An item converted and transcribed, as the owner's Mac would leave it. */
async function transcribedItem(): Promise<void> {
  store.createMedia({
    id: MEDIA_ID,
    topic: 'hermetismo',
    title: 'Entrevista',
    author: null,
    legacyAuthorship: 'outros-autores',
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
    durationMs: 60_000,
    bytes: 3,
  });
  const transcribe = workers().lease({ worker: 'mac', kinds: ['transcribe'] });
  if (transcribe?.kind !== 'transcribe') throw new Error('no transcription');
  await completeTranscript(transcribe);
}

const completeTranscript = (job: TranscribeJob) =>
  new TranscriptionService({ store, transcripts, files, now }).complete(
    { jobId: job.id, leaseId: job.leaseId, worker: 'mac' },
    {
      worker: 'mac',
      leaseId: job.leaseId,
      provider: 'mlx-whisper',
      model: 'mlx-community/whisper-large-v3-turbo',
      parametersVersion: '2026-10-28.1',
      parameters: {},
      termsVersion: 1,
      vad: 'applied',
      speechRatio: 0.9,
      elapsedMs: 100,
      raw: conversationRaw(),
    },
  );

function leaseFor(worker: string): DiarizeJob {
  const job = workers().lease({ worker, kinds: ['transcribe', 'diarize'] });
  if (job?.kind !== 'diarize') throw new Error('no separation');
  return job;
}

const complete = (job: DiarizeJob, worker: string) =>
  diarization().complete(
    { jobId: job.id, leaseId: job.leaseId, worker },
    {
      worker,
      leaseId: job.leaseId,
      engine: 'senko',
      model: 'senko',
      parametersVersion: '2026-11-03.1',
      parameters: {},
      requestedVoices: null,
      elapsedMs: 10,
      raw: { turns: [...CONVERSATION_TURNS] },
    },
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kbchat-diarize-'));
  clock = T0;
  const db = openMediaDatabase(':memory:', MEDIA_MIGRATIONS);
  database = db;
  store = new SqliteMediaStore(db);
  transcripts = new SqliteTranscriptStore(db);
  diarizations = new SqliteDiarizationStore(db);
  files = new FsMediaFiles(dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Files that let something happen while the raw file is being written. */
class FilesWithWrites extends FsMediaFiles {
  whileWriting: () => void = () => undefined;

  override async writeFile(path: string, data: string): Promise<void> {
    this.whileWriting();
    await super.writeFile(path, data);
  }
}

describe('A name saved while a new separation ends (KBC-065 BR-5)', () => {
  it('reaches the new separation, waiting to be confirmed', async () => {
    const slow = new FilesWithWrites(dir);
    files = slow;
    await transcribedItem();
    const ask = () =>
      diarizations.requestDiarization({
        mediaId: MEDIA_ID,
        jobId: crypto.randomUUID(),
        voices: null,
        now: clock,
      });
    ask();
    await complete(leaseFor('transcriber:mac'), 'transcriber:mac');
    const first = diarizations.latest(MEDIA_ID);
    if (!first) throw new Error('no separation');
    ask();
    const labels = new SqliteVoiceLabelStore(database);
    slow.whileWriting = () =>
      labels.setLabel({
        diarizationId: first.id,
        voice: 2,
        speakerId: null,
        audience: true,
      });

    await complete(leaseFor('transcriber:mac'), 'transcriber:mac');

    const second = diarizations.latest(MEDIA_ID);
    expect(second?.version).toBe(2);
    expect(second?.id && labels.labels(second.id)).toEqual([
      { voice: 2, speaker: null, audience: true, mergedInto: null },
    ]);
    expect(second?.namesPending).toBe(true);
  });
});

describe('A separation whose Mac stopped (KBC-064 AC-7)', () => {
  it('goes back to the queue when the lease expires and is stored once', async () => {
    await transcribedItem();
    diarizations.requestDiarization({
      mediaId: MEDIA_ID,
      jobId: crypto.randomUUID(),
      voices: null,
      now: clock,
    });
    const lost = leaseFor('transcriber:mac-1');
    clock = new Date(T0.getTime() + JOB_LEASE_MS + 1);
    expect(await janitor().sweep()).toMatchObject({ requeued: 1, failed: 0 });
    expect(diarizations.latestJob(MEDIA_ID)?.status).toBe('queued');
    expect(store.getMedia(MEDIA_ID)?.status).toBe('ready');

    const retaken = leaseFor('transcriber:mac-2');
    expect(retaken.attempt).toBe(2);
    await complete(retaken, 'transcriber:mac-2');
    await expect(complete(lost, 'transcriber:mac-1')).rejects.toMatchObject({
      code: 'MEDIA_CONFLICT',
    });
    expect(diarizations.latest(MEDIA_ID)?.version).toBe(1);
    // The late result left no raw file behind: one separation, one file.
    const raws = readdirSync(join(dir, 'transcripts', MEDIA_ID)).filter(
      (name) => name.startsWith('diarization-'),
    );
    expect(raws).toHaveLength(1);
  });

  it('gives a separation up after the last attempt, keeping the item and its transcript', async () => {
    await transcribedItem();
    diarizations.requestDiarization({
      mediaId: MEDIA_ID,
      jobId: crypto.randomUUID(),
      voices: 3,
      now: clock,
    });
    for (let attempt = 1; attempt <= 4; attempt++) {
      leaseFor('transcriber:mac');
      clock = new Date(clock.getTime() + JOB_LEASE_MS + 1);
      await janitor().sweep();
    }
    expect(diarizations.latestJob(MEDIA_ID)).toEqual({
      status: 'dead',
      voices: 3,
    });
    expect(store.getMedia(MEDIA_ID)).toMatchObject({
      status: 'ready',
      failure: null,
      transcription: { jobStatus: 'done', version: 1 },
    });
  });

  it('fails a crashed separation as retryable without touching the item', async () => {
    await transcribedItem();
    diarizations.requestDiarization({
      mediaId: MEDIA_ID,
      jobId: crypto.randomUUID(),
      voices: null,
      now: clock,
    });
    const job = leaseFor('transcriber:mac');
    await workers().fail(job.id, {
      worker: 'transcriber:mac',
      leaseId: job.leaseId,
      failure: 'conversion-failed',
      detail: 'coreml out of memory',
    });
    expect(diarizations.latestJob(MEDIA_ID)?.status).toBe('queued');
    expect(store.getMedia(MEDIA_ID)?.status).toBe('ready');
  });
});

describe('Edges of a separation (KBC-064)', () => {
  const actor = {
    principal: 'owner',
    isMaster: true,
    canSee: () => true,
  };
  const ask = () =>
    diarizations.requestDiarization({
      mediaId: MEDIA_ID,
      jobId: crypto.randomUUID(),
      voices: null,
      now: clock,
    });

  it('drops its raw file when the lease is lost while it is stored', async () => {
    await transcribedItem();
    ask();
    const job = leaseFor('transcriber:mac');
    diarizations.completeDiarize = () => false;
    await expect(complete(job, 'transcriber:mac')).rejects.toMatchObject({
      code: 'MEDIA_CONFLICT',
    });
    expect(
      readdirSync(join(dir, 'transcripts', MEDIA_ID)).filter((name) =>
        name.startsWith('diarization-'),
      ),
    ).toEqual([]);
  });

  it('refuses turns for an item whose transcript went meanwhile', async () => {
    await transcribedItem();
    ask();
    const job = leaseFor('transcriber:mac');
    openDb().exec(`DELETE FROM transcripts WHERE media_id = '${MEDIA_ID}'`);
    await expect(complete(job, 'transcriber:mac')).rejects.toMatchObject({
      code: 'MEDIA_NOT_READY',
    });
  });

  it('still says "done" when the job rows are gone, and nothing before a transcript', async () => {
    await transcribedItem();
    ask();
    await complete(leaseFor('transcriber:mac'), 'transcriber:mac');
    openDb().exec(`DELETE FROM jobs WHERE kind = 'diarize'`);
    expect(diarization().speakers(actor, MEDIA_ID)).toMatchObject({
      status: 'done',
      canRequest: true,
      transcriber: 'none',
    });
    openDb().exec(`DELETE FROM transcripts WHERE media_id = '${MEDIA_ID}'`);
    expect(diarization().speakers(actor, MEDIA_ID)).toMatchObject({
      status: 'none',
      canRequest: false,
      diarization: null,
    });
  });
});

describe('A database that fails while a separation is stored (review round 1)', () => {
  it('leaves no raw file behind', async () => {
    await transcribedItem();
    diarizations.requestDiarization({
      mediaId: MEDIA_ID,
      jobId: crypto.randomUUID(),
      voices: null,
      now: clock,
    });
    const job = leaseFor('transcriber:mac');
    diarizations.completeDiarize = () => {
      throw new Error('disk full');
    };
    await expect(complete(job, 'transcriber:mac')).rejects.toThrow('disk full');
    expect(
      readdirSync(join(dir, 'transcripts', MEDIA_ID)).filter((name) =>
        name.startsWith('diarization-'),
      ),
    ).toEqual([]);
  });
});

describe('Separations beside silence maps (KBC-064 with KBC-044)', () => {
  it('leases a separation while the item’s silences job waits or runs, and expires each on its own', async () => {
    await transcribedItem();
    diarizations.requestDiarization({
      mediaId: MEDIA_ID,
      jobId: crypto.randomUUID(),
      voices: 2,
      now: clock,
    });
    const silences = workers().lease({ worker: 'vm', kinds: ['silences'] });
    expect(silences?.kind).toBe('silences');
    // A transcriber never takes a silences job, and one running does not hold voices back.
    const job = leaseFor('transcriber:mac');
    expect(job).toMatchObject({ kind: 'diarize', voices: 2 });
    expect(job).not.toHaveProperty('detector');
    clock = new Date(clock.getTime() + JOB_LEASE_MS + 1);
    expect(await janitor().sweep()).toMatchObject({ requeued: 2, failed: 0 });
    expect(diarizations.latestJob(MEDIA_ID)).toEqual({
      status: 'queued',
      voices: 2,
    });
    expect(store.getMedia(MEDIA_ID)?.status).toBe('ready');
  });
});
