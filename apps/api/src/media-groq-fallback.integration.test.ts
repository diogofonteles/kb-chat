import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { GroqTranscribeJob } from '@kb-chat/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsMediaFiles } from './adapters/media/fs-media-files.js';
import { GroqClient } from './adapters/groq-client.js';
import { SecretBox } from './adapters/secret-box.js';
import { openMediaDatabase } from './adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from './adapters/sqlite/media-migrations.js';
import { SqliteGroqQueue } from './adapters/sqlite/sqlite-groq-queue.js';
import { SqliteMediaSettings } from './adapters/sqlite/sqlite-media-settings.js';
import { SqliteMediaSpendLedger } from './adapters/sqlite/sqlite-media-spend-ledger.js';
import { SqliteMediaStore } from './adapters/sqlite/sqlite-media-store.js';
import { SqliteTranscriberStore } from './adapters/sqlite/sqlite-transcriber-store.js';
import { SqliteTranscriptStore } from './adapters/sqlite/sqlite-transcript-store.js';
import { createLogger } from './logger.js';
import { GroqTranscriber } from './media-worker/groq-transcriber.js';
import type { ChunkPlan } from './media-worker/speech-chunks.js';
import {
  GroqPacer,
  GroqService,
  TranscriberService,
  TranscriptionService,
  WorkerService,
} from './modules/media/index.js';
import { FakeGroq } from './testing/fake-groq.js';

// KBC-037: Groq as the transcription fallback, over the real queue and ledger, with a fake
// Groq and a fake clock (AC-1, AC-2, AC-3, AC-6; BR-2 over many requests).

const T0 = new Date('2026-11-03T12:00:00.000Z');
const HOUR = 3_600_000;
const KEY = 'gsk_test_valid';
const VM_TOKEN = 'vm-token-0123456789abcdef0123456789';

let dir: string;
let clock: Date;
let groqFake: FakeGroq;
let s: ReturnType<typeof stores>;

const now = () => clock;
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

function stores() {
  const db = openMediaDatabase(':memory:', MEDIA_MIGRATIONS);
  const files = new FsMediaFiles(dir);
  const store = new SqliteMediaStore(db);
  const transcripts = new SqliteTranscriptStore(db);
  const transcriberStore = new SqliteTranscriberStore(db);
  const ledger = new SqliteMediaSpendLedger(db);
  const transcribers = new TranscriberService({
    store: transcriberStore,
    tokenKey: Buffer.alloc(32, 1),
    vmToken: VM_TOKEN,
    now,
  });
  const groq = new GroqService({
    settings: new SqliteMediaSettings(db),
    sealer: new SecretBox(Buffer.alloc(32, 2)),
    groq: new GroqClient({ fetch: groqFake.fetch }),
    ledger,
    queue: new SqliteGroqQueue(db),
    transcripts,
    presence: () => transcribers.presence('transcribe'),
    pacer: new GroqPacer(),
    defaultCapUsd: 10,
    log: createLogger('silent'),
    now,
  });
  const workers = new WorkerService({
    store,
    files,
    termsVersion: () => transcripts.currentTerms().version,
    now,
  });
  const transcription = new TranscriptionService({
    store,
    transcripts,
    files,
    now,
  });
  return {
    db,
    files,
    store,
    transcripts,
    ledger,
    transcribers,
    groq,
    workers,
    transcription,
  };
}

/** An item the VM converted at `clock`, its transcription queued for the Mac. */
async function readyItem(durationMs: number): Promise<string> {
  const id = crypto.randomUUID();
  s.store.createMedia({
    id,
    topic: 'hermetismo',
    title: 'Palestra',
    author: 'mestre-laercio',
    legacyAuthorship: 'mestre-laercio',
    ownerPrincipal: 'owner',
    fileName: 'a.mp3',
    uploadBytes: 3,
    now: clock,
  });
  await s.files.saveUpload({
    mediaId: id,
    body: Readable.from([Buffer.from('abc')]),
    expectedBytes: 3,
  });
  s.store.markUploaded({ mediaId: id, jobId: crypto.randomUUID(), now: clock });
  const job = s.workers.lease({ worker: 'vm', kinds: ['transcode'] });
  if (job?.kind !== 'transcode') throw new Error('no conversion');
  await s.files.writeFile(job.targetPath, 'aac');
  await s.workers.completeTranscode(job.id, {
    worker: 'vm',
    leaseId: job.leaseId,
    durationMs,
    bytes: 3,
  });
  return id;
}

/** The Mac, paired and last seen at `seenAt`. */
function macSeenAt(seenAt: Date): void {
  const paired = s.transcribers.pair({
    name: 'Mac do dono',
    pairedBy: 'owner',
  });
  s.db
    .prepare(
      'UPDATE transcribers SET last_seen_at = ?, created_at = ? WHERE id = ?',
    )
    .run(seenAt.toISOString(), seenAt.toISOString(), paired.transcriber.id);
}

async function connect(mode: 'never' | 'manual' | 'idle', idleHours = 12) {
  const tested = await s.groq.test({ key: KEY, by: 'owner' }, true);
  expect(tested.ok).toBe(true);
  s.groq.setMode({ mode, idleHours }, 'owner');
}

function leaseGroq(): GroqTranscribeJob | null {
  const job = s.workers.lease({
    worker: 'vm',
    kinds: ['transcribe'],
    transcribeRoute: 'groq',
  });
  if (!job) return null;
  if (!('provider' in job)) throw new Error('not a Groq job');
  return job;
}

/** The VM worker's adapter, its API calls going straight to the services. */
function vmWorker(plan: ChunkPlan) {
  const owner = (job: GroqTranscribeJob) => ({
    jobId: job.id,
    leaseId: job.leaseId,
    worker: 'vm',
  });
  return new GroqTranscriber({
    api: {
      sendGroqChunk: async (job, chunk) => {
        try {
          return await s.groq.transcribeChunk(owner(job), {
            query: {
              worker: 'vm',
              leaseId: job.leaseId,
              ...chunk.span,
              termsVersion: job.termsVersion,
            },
            audio: chunk.audio,
          });
        } catch {
          return { kind: 'lost' };
        }
      },
      completeGroq: async (job, done) => {
        await s.transcription.complete(owner(job), {
          ...done,
          provider: 'groq',
          model: 'whisper-large-v3-turbo',
          parametersVersion: 'test',
          parameters: {},
        });
        return true;
      },
    },
    plan: async () => ({ source: 'unused', plan }),
    read: async () => Buffer.from('fLaC chunk'),
    sleep: async () => undefined,
  });
}

const TWO_CHUNKS: ChunkPlan = {
  chunks: [
    { startMs: 0, endMs: 20_000 },
    { startMs: 21_000, endMs: 40_000 },
  ],
  vad: 'applied',
  speechRatio: 0.95,
};

/** Spends `usd` of the month, as a settled run would have. */
function spent(usd: number): void {
  s.ledger.reserve({
    id: crypto.randomUUID(),
    kind: 'track-proposal',
    mediaId: 'x',
    principal: 'owner',
    usd,
    capUsd: 1_000,
    since: new Date(0),
    now: clock,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kbchat-groq-'));
  clock = T0;
  groqFake = new FakeGroq();
  s = stores();
});
afterEach(() => {
  s.store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Groq is never used unless a master turns it on (BR-1)', () => {
  it('sends nothing in "Nunca", with the key connected and the Mac off for 48 h (AC-1)', async () => {
    macSeenAt(T0);
    const id = await readyItem(HOUR);
    await connect('never');
    clock = at(48);

    expect(s.groq.sweep()).toBe(0);
    expect(leaseGroq()).toBeNull();
    expect(() => s.groq.sendItem(id)).toThrow(
      expect.objectContaining({ code: 'GROQ_UNAVAILABLE' }),
    );
    expect(groqFake.calls).toEqual([]);
    expect(s.store.getMedia(id)?.transcription).toMatchObject({
      jobStatus: 'queued',
      route: 'transcriber',
    });
  });

  it('starts in "Nunca", with no key', () => {
    expect(s.groq.view(true)).toMatchObject({
      connected: false,
      mode: 'never',
      idleHours: 12,
      month: { spentUsd: 0, capUsd: 10 },
    });
    expect(s.groq.ready()).toBe(false);
  });
});

describe('The scheduler in "parado há mais de N horas" (FR-2)', () => {
  it('sends a job waiting 13 h, with no Mac seen in 12 h, and Groq transcribes it (AC-2)', async () => {
    macSeenAt(T0);
    const id = await readyItem(40_000);
    await connect('idle', 12);
    clock = at(13);

    expect(s.groq.sweep()).toBe(1);
    expect(s.store.getMedia(id)?.transcription.route).toBe('groq');
    // The Mac, if it wakes up now, no longer takes it.
    expect(
      s.workers.lease({ worker: 'transcriber:mac', kinds: ['transcribe'] }),
    ).toBeNull();
    const job = leaseGroq();
    if (!job) throw new Error('the VM got no Groq job');
    expect(job).toMatchObject({ mediaId: id, termsVersion: 1 });

    expect(
      await vmWorker(TWO_CHUNKS).run(job, {
        signal: new AbortController().signal,
      }),
    ).toBe('done');

    expect(groqFake.calls).toHaveLength(2);
    expect(s.store.getMedia(id)?.transcription).toMatchObject({
      jobStatus: 'done',
      version: 1,
      provider: 'groq',
    });
    // Each request reserved and settled its own cost: 20 s and 19 s at US$ 0.04 an hour.
    expect(s.groq.view(true).month.spentUsd).toBeCloseTo(
      (39 / 3_600) * 0.04,
      8,
    );
  });

  it('leaves a job that waited 11 h, or one whose Mac was seen 2 h ago', async () => {
    macSeenAt(at(11));
    await readyItem(HOUR);
    await connect('idle', 12);
    clock = at(11);
    expect(s.groq.sweep()).toBe(0);
    clock = at(13);
    expect(s.groq.sweep()).toBe(0);
    expect(groqFake.calls).toEqual([]);
  });

  it('counts no transcriber paired as none seen', async () => {
    await readyItem(HOUR);
    await connect('idle', 1);
    clock = at(2);
    expect(s.groq.sweep()).toBe(1);
  });

  it('does nothing in "Só quando eu pedir" until a master asks for one item', async () => {
    macSeenAt(T0);
    const id = await readyItem(HOUR);
    await connect('manual');
    clock = at(48);
    expect(s.groq.sweep()).toBe(0);
    s.groq.sendItem(id);
    expect(s.store.getMedia(id)?.transcription.route).toBe('groq');
    expect(() => s.groq.sendItem(id)).toThrow(
      expect.objectContaining({ code: 'MEDIA_CONFLICT' }),
    );
  });
});

describe('The media monthly cap (BR-2, FR-4)', () => {
  it('sends nothing when 1 h would cross US$ 9.99 of 10, and says why (AC-3)', async () => {
    const id = await readyItem(HOUR);
    await connect('idle', 1);
    spent(9.99);
    clock = at(2);

    expect(s.groq.sweep()).toBe(0);
    expect(leaseGroq()).toBeNull();
    expect(groqFake.calls).toEqual([]);
    expect(s.store.getMedia(id)?.transcription).toMatchObject({
      jobStatus: 'queued',
      route: 'transcriber',
      hold: 'monthly-cap',
    });
    expect(() => s.groq.sendItem(id)).toThrow(
      expect.objectContaining({ code: 'MEDIA_SPEND_CAP' }),
    );
  });

  it('stops a job mid-way when its next chunk does not fit, sending nothing more', async () => {
    const id = await readyItem(40_000);
    await connect('manual');
    s.groq.sendItem(id);
    const job = leaseGroq();
    if (!job) throw new Error('no Groq job');
    // What the month has left fits the first chunk only.
    spent(10 - (25 / 3_600) * 0.04);

    expect(
      await vmWorker(TWO_CHUNKS).run(job, {
        signal: new AbortController().signal,
      }),
    ).toBe('lost');

    expect(groqFake.calls).toHaveLength(1);
    expect(s.store.getMedia(id)?.transcription).toMatchObject({
      jobStatus: 'queued',
      route: 'transcriber',
      hold: 'monthly-cap',
    });
    expect(s.groq.view(true).month.spentUsd).toBeLessThanOrEqual(10);
    // The Mac takes it back.
    expect(
      s.workers.lease({ worker: 'transcriber:mac', kinds: ['transcribe'] }),
    ).toMatchObject({ mediaId: id });
  });

  it('holds the cap over many requests in a row, counting the 10 s minimum', async () => {
    const id = await readyItem(10_000);
    await connect('manual');
    s.groq.sendItem(id);
    // Room for three and a half requests of the 10 s minimum.
    const tenSeconds = (10 / 3_600) * 0.04;
    s.groq.setCap(3.5 * tenSeconds, 'owner');
    const job = leaseGroq();
    if (!job) throw new Error('no Groq job');
    const tiny: ChunkPlan = {
      chunks: Array.from({ length: 5 }, (_, n) => ({
        startMs: n * 2_000,
        endMs: n * 2_000 + 1_000,
      })),
      vad: 'applied',
      speechRatio: 0.5,
    };

    expect(
      await vmWorker(tiny).run(job, { signal: new AbortController().signal }),
    ).toBe('lost');

    // 1 s chunks are billed as 10 s: three fit, the fourth would cross the cap.
    expect(groqFake.calls).toHaveLength(3);
    expect(s.groq.view(true).month.spentUsd).toBeCloseTo(3 * tenSeconds, 12);
    expect(s.groq.view(true).month.spentUsd).toBeLessThanOrEqual(
      s.groq.capUsd(),
    );
  });

  it('refunds a request Groq refused with 429 and passes its wait on', async () => {
    const id = await readyItem(40_000);
    await connect('manual');
    s.groq.sendItem(id);
    const job = leaseGroq();
    if (!job) throw new Error('no Groq job');
    groqFake.rateLimitNext(1, 30);
    const owner = { jobId: job.id, leaseId: job.leaseId, worker: 'vm' };
    const query = {
      worker: 'vm',
      leaseId: job.leaseId,
      startMs: 0,
      endMs: 20_000,
      termsVersion: 1,
    };

    expect(
      await s.groq.transcribeChunk(owner, { query, audio: Buffer.from('x') }),
    ).toEqual({ kind: 'wait', retryAfterMs: 30_000 });
    expect(s.groq.view(true).month.spentUsd).toBe(0);
  });

  it('gives the job back to the Mac when Groq no longer accepts the key', async () => {
    const id = await readyItem(40_000);
    await connect('manual');
    s.groq.sendItem(id);
    const job = leaseGroq();
    if (!job) throw new Error('no Groq job');
    groqFake.revokeKeys();

    expect(
      await vmWorker(TWO_CHUNKS).run(job, {
        signal: new AbortController().signal,
      }),
    ).toBe('lost');

    expect(s.store.getMedia(id)?.transcription).toMatchObject({
      jobStatus: 'queued',
      route: 'transcriber',
      hold: null,
    });
    expect(s.groq.view(true).month.spentUsd).toBe(0);
  });

  it('stops a job when a master turns Groq off meanwhile', async () => {
    const id = await readyItem(40_000);
    await connect('manual');
    s.groq.sendItem(id);
    const job = leaseGroq();
    if (!job) throw new Error('no Groq job');
    s.groq.setMode({ mode: 'never', idleHours: 12 }, 'owner');

    expect(
      await vmWorker(TWO_CHUNKS).run(job, {
        signal: new AbortController().signal,
      }),
    ).toBe('lost');

    expect(groqFake.calls).toEqual([]);
    expect(s.store.getMedia(id)?.transcription.route).toBe('transcriber');
  });
});

describe('The term list in every request (FR-3)', () => {
  it('sends the list as the prompt of each chunk, so "Hoasca" comes out as listed (AC-6)', async () => {
    const id = await readyItem(40_000);
    await connect('manual');
    s.groq.sendItem(id);
    const job = leaseGroq();
    if (!job) throw new Error('no Groq job');

    await vmWorker(TWO_CHUNKS).run(job, {
      signal: new AbortController().signal,
    });

    expect(groqFake.calls).toHaveLength(2);
    for (const call of groqFake.calls) {
      expect(call.prompt).toContain('Hoasca');
      expect(call.prompt).toMatch(/\.$/);
      expect(call.model).toBe('whisper-large-v3-turbo');
      expect(call.language).toBe('pt');
    }
    const [current] = s.transcripts.transcripts(id);
    const words = s.transcripts
      .words(current?.id ?? '')
      .map((word) => word.text.trim());
    expect(words.filter((word) => word === 'Hoasca')).toHaveLength(2);
    expect(words).not.toContain('Oasca');
  });
});
