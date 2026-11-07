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
    groqWaits: () => groq.waits(),
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

/** An upload just received: its conversion waits for the VM. */
async function uploaded(): Promise<string> {
  const id = crypto.randomUUID();
  s.store.createMedia({
    id,
    topic: 'hermetismo',
    title: 'Envio novo',
    author: 'mestre-laercio',
    legacyAuthorship: 'mestre-laercio',
    ownerPrincipal: 'owner',
    fileName: 'b.mp3',
    uploadBytes: 3,
    now: clock,
  });
  await s.files.saveUpload({
    mediaId: id,
    body: Readable.from([Buffer.from('abc')]),
    expectedBytes: 3,
  });
  s.store.markUploaded({ mediaId: id, jobId: crypto.randomUUID(), now: clock });
  return id;
}

/** The VM's lease, every kind it takes (the worker's own list). */
const leaseVm = () =>
  s.workers.lease({
    worker: 'vm',
    kinds: ['transcode', 'silences', 'waveform', 'cut', 'transcribe'],
    transcribeRoute: 'groq',
  });

/** Every job the VM takes now, in its order, as `kind:media`. */
function vmTakes(): string[] {
  const taken: string[] = [];
  for (let job = leaseVm(); job; job = leaseVm())
    // A kb-publish job (KBC-099) names a collection, not a media item.
    taken.push(`${job.kind}:${'mediaId' in job ? job.mediaId : job.topic}`);
  return taken;
}

const jobRow = (id: string) =>
  s.db
    .prepare('SELECT status, route, hold, attempts FROM jobs WHERE id = ?')
    .get(id);

const chunkOf = (
  job: GroqTranscribeJob,
  span: { startMs: number; endMs: number },
) => ({
  query: {
    worker: 'vm',
    leaseId: job.leaseId,
    ...span,
    termsVersion: job.termsVersion,
  },
  audio: Buffer.from('fLaC chunk'),
});

const ownerOf = (job: GroqTranscribeJob) => ({
  jobId: job.id,
  leaseId: job.leaseId,
  worker: 'vm',
});

const conflict = expect.objectContaining({ code: 'MEDIA_CONFLICT' });

describe('Conversions never wait behind Groq (the VM has one slot)', () => {
  it('leases a new upload’s conversion before an older Groq transcription', async () => {
    const old = await readyItem(HOUR);
    await connect('idle', 1);
    clock = at(2);
    expect(s.groq.sweep()).toBe(1);
    const fresh = await uploaded();

    const taken = vmTakes();
    expect(taken).toContain(`transcode:${fresh}`);
    expect(taken.at(-1)).toBe(`transcribe:${old}`);
  });

  it('hands a Groq job back, keeping its place and attempts, when a conversion arrives', async () => {
    const old = await readyItem(40_000);
    await connect('manual');
    s.groq.sendItem(old);
    const job = leaseGroq();
    if (!job) throw new Error('no Groq job');
    const before = jobRow(job.id);
    const fresh = await uploaded();

    await expect(
      s.groq.transcribeChunk(
        ownerOf(job),
        chunkOf(job, { startMs: 0, endMs: 20_000 }),
      ),
    ).rejects.toEqual(conflict);

    expect(groqFake.calls).toEqual([]);
    expect(jobRow(job.id)).toEqual({
      ...before,
      status: 'queued',
      attempts: 0,
    });
    const taken = vmTakes();
    expect(taken).toContain(`transcode:${fresh}`);
    expect(taken.at(-1)).toBe(`transcribe:${old}`);
  });

  it('hands the job back instead of sleeping through a long wait, and the VM takes it again after', async () => {
    const id = await readyItem(40_000);
    await connect('manual');
    s.groq.sendItem(id);
    const job = leaseGroq();
    if (!job) throw new Error('no Groq job');
    groqFake.rateLimitNext(1, 3_600);

    await expect(
      s.groq.transcribeChunk(
        ownerOf(job),
        chunkOf(job, { startMs: 0, endMs: 20_000 }),
      ),
    ).rejects.toEqual(conflict);

    expect(jobRow(job.id)).toMatchObject({
      status: 'queued',
      route: 'groq',
      attempts: 0,
    });
    // A new upload converts meanwhile; the Groq job waits for its hour.
    const fresh = await uploaded();
    const taken = vmTakes();
    expect(taken).toContain(`transcode:${fresh}`);
    expect(taken).not.toContain(`transcribe:${id}`);
    clock = new Date(clock.getTime() + HOUR + 1_000);
    expect(leaseVm()).toMatchObject({ kind: 'transcribe', mediaId: id });
  });

  it('still waits a short pause holding the job (the minute window)', async () => {
    const id = await readyItem(40_000);
    await connect('manual');
    s.groq.sendItem(id);
    const job = leaseGroq();
    if (!job) throw new Error('no Groq job');
    groqFake.rateLimitNext(1, 30);

    expect(
      await s.groq.transcribeChunk(
        ownerOf(job),
        chunkOf(job, { startMs: 0, endMs: 20_000 }),
      ),
    ).toEqual({ kind: 'wait', retryAfterMs: 30_000 });
    expect(jobRow(job.id)).toMatchObject({ status: 'leased' });
  });
});

describe('A chunk Groq transcribed is paid once', () => {
  it('keeps each paid chunk, so a new lease pays only the rest', async () => {
    const id = await readyItem(60_000);
    await connect('manual');
    s.groq.sendItem(id);
    const three: ChunkPlan = {
      chunks: [
        { startMs: 0, endMs: 20_000 },
        { startMs: 20_000, endMs: 40_000 },
        { startMs: 40_000, endMs: 60_000 },
      ],
      vad: 'applied',
      speechRatio: 0.9,
    };
    const first = leaseGroq();
    if (!first) throw new Error('no Groq job');
    // Two chunks paid, then the VM restarts: the lease runs out.
    for (const span of three.chunks.slice(0, 2))
      await s.groq.transcribeChunk(ownerOf(first), chunkOf(first, span));
    const paid = s.groq.view(true).month.spentUsd;
    clock = new Date(clock.getTime() + HOUR);
    s.store.reapExpired({ now: clock, maxAttempts: 4 });

    const second = leaseGroq();
    if (!second) throw new Error('no Groq job again');
    expect(
      await vmWorker(three).run(second, {
        signal: new AbortController().signal,
      }),
    ).toBe('done');

    expect(groqFake.calls).toHaveLength(3);
    expect(s.groq.view(true).month.spentUsd).toBeCloseTo(
      paid + (20 / 3_600) * 0.04,
      10,
    );
    expect(s.store.getMedia(id)?.transcription.jobStatus).toBe('done');
  });
});

describe('A 200 whose body breaks', () => {
  it('is counted as spent, since Groq charged it (NFR-1)', async () => {
    const id = await readyItem(40_000);
    await connect('manual');
    s.groq.sendItem(id);
    const job = leaseGroq();
    if (!job) throw new Error('no Groq job');
    groqFake.breakNextBody();

    await expect(
      s.groq.transcribeChunk(
        ownerOf(job),
        chunkOf(job, { startMs: 0, endMs: 20_000 }),
      ),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }),
    );
    expect(s.groq.view(true).month.spentUsd).toBeCloseTo(
      (20 / 3_600) * 0.04,
      10,
    );
  });
});

describe('The estimate counts what is already Groq’s (BR-2, FR-4)', () => {
  it('routes one of two 1 h items when the month has US$ 0.05 left', async () => {
    const a = await readyItem(HOUR);
    clock = new Date(T0.getTime() + 1_000);
    const b = await readyItem(HOUR);
    await connect('idle', 1);
    spent(10 - 0.05);
    clock = at(2);

    expect(s.groq.sweep()).toBe(1);
    expect(s.store.getMedia(a)?.transcription.route).toBe('groq');
    expect(s.store.getMedia(b)?.transcription).toMatchObject({
      route: 'transcriber',
      hold: 'monthly-cap',
    });
    expect(() => s.groq.sendItem(b)).toThrow(
      expect.objectContaining({ code: 'MEDIA_SPEND_CAP' }),
    );
  });

  it('does not route an item whose length is unknown', async () => {
    const id = await readyItem(HOUR);
    s.db.prepare('UPDATE media SET duration_ms = NULL WHERE id = ?').run(id);
    await connect('idle', 1);
    clock = at(2);

    expect(s.groq.sweep()).toBe(0);
    expect(s.store.getMedia(id)?.transcription.route).toBe('transcriber');
  });
});

describe('Groq is the Mac’s fallback: a job it cannot finish goes back (ADR 0023 §7)', () => {
  it('gives a job back to the Mac after its last Groq attempt, keeping the FLAC', async () => {
    const id = await readyItem(40_000);
    await s.files.writeFile(s.files.flacPath(id), 'flac');
    await connect('manual');
    s.groq.sendItem(id);
    for (let attempt = 1; attempt <= 4; attempt++) {
      const job = leaseGroq();
      if (!job) throw new Error(`no Groq job on attempt ${attempt}`);
      await s.workers.fail(job.id, {
        worker: 'vm',
        leaseId: job.leaseId,
        failure: 'conversion-failed',
        detail: 'Groq kept failing',
      });
    }

    expect(leaseGroq()).toBeNull();
    const media = s.store.getMedia(id);
    expect(media?.transcription).toMatchObject({
      jobStatus: 'queued',
      route: 'transcriber',
    });
    expect(await s.files.stat(s.files.flacPath(id))).not.toBeNull();
    expect(
      s.workers.lease({ worker: 'transcriber:mac', kinds: ['transcribe'] }),
    ).toMatchObject({ mediaId: id, attempt: 1 });
  });

  it('gives a job back to the Mac when its Groq lease runs out for the last time', async () => {
    const id = await readyItem(40_000);
    await connect('manual');
    s.groq.sendItem(id);
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(leaseGroq()).not.toBeNull();
      clock = new Date(clock.getTime() + HOUR);
      expect(
        s.store.reapExpired({ now: clock, maxAttempts: 4 })
          .transcriptionsGivenUp,
      ).toEqual([]);
    }
    expect(s.store.getMedia(id)?.transcription).toMatchObject({
      jobStatus: 'queued',
      route: 'transcriber',
    });
  });
});

describe('A key Groq stops accepting (QA BUG-1)', () => {
  it('is marked refused, so later sweeps send nothing and the Mac keeps its attempts', async () => {
    const id = await readyItem(40_000);
    await connect('idle', 1);
    clock = at(2);
    groqFake.revokeKeys();

    for (let sweep = 0; sweep < 5; sweep++) {
      s.groq.sweep();
      const job = leaseGroq();
      if (job)
        await vmWorker(TWO_CHUNKS).run(job, {
          signal: new AbortController().signal,
        });
      clock = new Date(clock.getTime() + 60_000);
    }

    expect(groqFake.refused).toBe(1);
    expect(s.groq.view(true)).toMatchObject({
      connected: true,
      keyProblem: 'rejected',
    });
    expect(s.groq.ready()).toBe(false);
    const job = s.workers.lease({
      worker: 'transcriber:mac',
      kinds: ['transcribe'],
    });
    expect(job).toMatchObject({ mediaId: id, attempt: 1 });
  });

  it('is accepted again after a master pastes a key Groq takes', async () => {
    await connect('manual');
    groqFake.revokeKeys();
    const id = await readyItem(40_000);
    s.groq.sendItem(id);
    const job = leaseGroq();
    if (!job) throw new Error('no Groq job');
    await vmWorker(TWO_CHUNKS).run(job, {
      signal: new AbortController().signal,
    });
    expect(s.groq.view(true).keyProblem).toBe('rejected');

    expect(await s.groq.test({ by: 'owner' }, true)).toEqual({
      ok: false,
      reason: 'key-rejected',
    });
    groqFake.restoreKeys();
    expect(await s.groq.test({ key: KEY, by: 'owner' }, true)).toMatchObject({
      ok: true,
      settings: { keyProblem: null },
    });
    expect(s.groq.ready()).toBe(true);
  });
});

describe('A sealed key that no longer opens (QA BUG-3)', () => {
  it('reads as a key to paste again, never a raw error', async () => {
    const id = await readyItem(40_000);
    await connect('manual');
    s.groq.sendItem(id);
    const job = leaseGroq();
    if (!job) throw new Error('no Groq job');
    // KB_CHAT_SECRETS_KEY changed: the stored value no longer opens.
    s.db
      .prepare(
        `UPDATE media_settings SET value = json_set(value, '$.sealedKey', 'v1.not-sealed-by-this-key')
         WHERE key = 'groq'`,
      )
      .run();

    expect(s.groq.view(true)).toMatchObject({
      connected: true,
      keyProblem: 'unreadable',
    });
    expect(s.groq.ready()).toBe(false);
    expect(await s.groq.test({ by: 'owner' }, true)).toEqual({
      ok: false,
      reason: 'key-unreadable',
    });
    await expect(
      s.groq.transcribeChunk(
        ownerOf(job),
        chunkOf(job, { startMs: 0, endMs: 20_000 }),
      ),
    ).rejects.toEqual(conflict);
    expect(s.store.getMedia(id)?.transcription.route).toBe('transcriber');
    expect(groqFake.calls).toEqual([]);
  });
});
