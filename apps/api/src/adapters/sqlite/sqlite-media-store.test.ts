import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LeasedJob, NewMedia } from '../../ports/media-store.js';
import { applyMigrations, openMediaDatabase } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';
import { SqliteMediaStore } from './sqlite-media-store.js';

const T0 = new Date('2026-10-28T12:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 4;

let store: SqliteMediaStore;
let sequence = 0;

const aMedia = (overrides: Partial<NewMedia> = {}): NewMedia => {
  sequence++;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    topic: 'hermetismo',
    title: `Palestra ${sequence}`,
    authorship: 'mestre-laercio',
    ownerPrincipal: 'owner',
    fileName: 'palestra.mp3',
    uploadBytes: 3_000_000,
    now: at(sequence),
    ...overrides,
  };
};

/** A media item uploaded and waiting in the queue. */
function queued(overrides: Partial<NewMedia> = {}) {
  const media = store.createMedia(aMedia(overrides));
  return store.markUploaded({
    mediaId: media.id,
    jobId: crypto.randomUUID(),
    now: at(sequence),
  });
}

const lease = (seconds = 0, worker = 'vm'): LeasedJob | null =>
  store.leaseJob({
    kinds: ['transcode'],
    worker,
    now: at(seconds),
    leaseMs: LEASE_MS,
  });

function leased(seconds = 0): LeasedJob {
  const job = lease(seconds);
  if (!job) throw new Error('nothing to lease');
  return job;
}

const owner = (job: LeasedJob, worker = 'vm') => ({
  jobId: job.id,
  leaseId: job.leaseId,
  worker,
});

beforeEach(() => {
  store = new SqliteMediaStore(openMediaDatabase(':memory:', MEDIA_MIGRATIONS));
});
afterEach(() => store.close());

describe('SqliteMediaStore catalog', () => {
  it('creates an item as uploading and lists a collection newest first', () => {
    const first = store.createMedia(aMedia());
    const second = store.createMedia(aMedia());
    store.createMedia(aMedia({ topic: 'alquimia' }));
    expect(first).toMatchObject({
      status: 'uploading',
      progress: null,
      failure: null,
      durationMs: null,
      bytes: null,
      ownerPrincipal: 'owner',
    });
    expect(store.listMedia('hermetismo').map((m) => m.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(store.getMedia('11111111-1111-4111-8111-111111111111')).toBeNull();
  });

  it('refuses an authorship the schema does not know', () => {
    expect(() =>
      store.createMedia(aMedia({ authorship: 'sintese' as never })),
    ).toThrow();
  });

  it('queues an uploaded item once, and only from uploading', () => {
    const media = queued();
    expect(media.status).toBe('queued');
    expect(() =>
      store.markUploaded({
        mediaId: media.id,
        jobId: crypto.randomUUID(),
        now: T0,
      }),
    ).toThrow(/not uploading/);
  });

  it('removes an item with its jobs and renditions', () => {
    const media = queued();
    const job = leased();
    store.completeTranscode({
      transcribeJobId: crypto.randomUUID(),
      ...owner(job),
      durationMs: 1_000,
      now: at(5),
      rendition: rendition(media.id),
    });
    expect(store.deleteMedia(media.id)).toBe(true);
    expect(store.getMedia(media.id)).toBeNull();
    expect(store.getRendition(media.id)).toBeNull();
    expect(lease(10)).toBeNull();
    expect(store.deleteMedia(media.id)).toBe(false);
  });
});

const rendition = (mediaId: string) => ({
  mediaId,
  rendition: 'audio' as const,
  path: `audio/${mediaId}.m4a`,
  bytes: 480_000,
  mime: 'audio/mp4',
});

describe('SqliteMediaStore queue', () => {
  it('leases the oldest queued job and marks the item as processing at 0%', () => {
    const first = queued();
    queued();
    const job = leased();
    expect(job).toMatchObject({
      kind: 'transcode',
      mediaId: first.id,
      attempt: 1,
    });
    expect(store.getMedia(first.id)).toMatchObject({
      status: 'processing',
      progress: 0,
    });
  });

  it('leases nothing when the queue is empty or no kind is asked', () => {
    expect(lease()).toBeNull();
    queued();
    expect(
      store.leaseJob({ kinds: [], worker: 'vm', now: T0, leaseMs: LEASE_MS }),
    ).toBeNull();
  });

  it('never gives the same job to two workers', () => {
    queued();
    expect(lease(0, 'a')).not.toBeNull();
    expect(lease(0, 'b')).toBeNull();
  });

  it('extends the lease and records progress on a heartbeat of the lease owner', () => {
    const media = queued();
    const job = leased();
    const beat = {
      ...owner(job),
      progress: 40,
      now: at(50),
      leaseMs: LEASE_MS,
    };
    expect(store.heartbeat(beat)).toBe(true);
    expect(store.getMedia(media.id)?.progress).toBe(40);
    // The lease now ends at 110 s: still held at 100 s.
    expect(
      store.reapExpired({ now: at(100), maxAttempts: MAX_ATTEMPTS }),
    ).toEqual({
      requeued: 0,
      failed: 0,
      transcriptionsGivenUp: [],
    });
  });

  it('keeps the progress when a heartbeat has none', () => {
    const media = queued();
    const job = leased();
    store.heartbeat({
      ...owner(job),
      progress: 30,
      now: at(1),
      leaseMs: LEASE_MS,
    });
    store.heartbeat({
      ...owner(job),
      progress: null,
      now: at(2),
      leaseMs: LEASE_MS,
    });
    expect(store.getMedia(media.id)?.progress).toBe(30);
  });

  it('refuses a heartbeat, completion or failure from anyone but the lease owner', () => {
    queued();
    const job = leased();
    const stranger = { ...owner(job), leaseId: crypto.randomUUID() };
    const beat = { progress: 1, now: at(1), leaseMs: LEASE_MS };
    expect(store.heartbeat({ ...stranger, ...beat })).toBe(false);
    expect(store.heartbeat({ ...owner(job, 'other'), ...beat })).toBe(false);
    expect(
      store.completeTranscode({
        transcribeJobId: crypto.randomUUID(),
        ...stranger,
        durationMs: 1,
        now: at(1),
        rendition: rendition(job.mediaId),
      }),
    ).toBe(false);
    expect(
      store.failJob({
        ...stranger,
        failure: 'conversion-failed',
        detail: '',
        now: at(1),
        maxAttempts: MAX_ATTEMPTS,
      }),
    ).toBe(false);
  });

  it('makes the item ready with its duration and rendition on completion', () => {
    const media = queued();
    const job = leased();
    expect(
      store.completeTranscode({
        transcribeJobId: crypto.randomUUID(),
        ...owner(job),
        durationMs: 180_000,
        now: at(30),
        rendition: rendition(media.id),
      }),
    ).toBe(true);
    expect(store.getMedia(media.id)).toMatchObject({
      status: 'ready',
      progress: null,
      durationMs: 180_000,
      bytes: 480_000,
    });
    expect(store.getRendition(media.id)).toEqual(rendition(media.id));
    expect(lease(31)).toBeNull();
  });

  it('fails an invalid file at once, without a retry (AC-6, BR-5)', () => {
    const media = queued();
    const job = leased();
    store.failJob({
      ...owner(job),
      failure: 'invalid-audio',
      detail: 'no audio stream',
      now: at(2),
      maxAttempts: MAX_ATTEMPTS,
    });
    expect(store.getMedia(media.id)).toMatchObject({
      status: 'failed',
      failure: 'invalid-audio',
    });
    expect(lease(3)).toBeNull();
  });

  it('queues a crashed conversion again until the attempts run out', () => {
    const media = queued();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const job = leased(attempt);
      expect(job.attempt).toBe(attempt);
      store.failJob({
        ...owner(job),
        failure: 'conversion-failed',
        detail: 'ffmpeg exited with 1',
        now: at(attempt),
        maxAttempts: MAX_ATTEMPTS,
      });
      const expected = attempt < MAX_ATTEMPTS ? 'queued' : 'failed';
      expect(store.getMedia(media.id)?.status).toBe(expected);
    }
    expect(store.getMedia(media.id)?.failure).toBe('conversion-failed');
    expect(lease(99)).toBeNull();
  });

  it('gives expired leases back to the queue, then gives up on the 4th (AC-5)', () => {
    const media = queued();
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      leased(attempt * 100);
      const reaped = store.reapExpired({
        now: at(attempt * 100 + 61),
        maxAttempts: MAX_ATTEMPTS,
      });
      expect(reaped).toEqual({
        requeued: 1,
        failed: 0,
        transcriptionsGivenUp: [],
      });
      expect(store.getMedia(media.id)).toMatchObject({
        status: 'queued',
        progress: null,
      });
    }
    leased(1_000);
    expect(
      store.reapExpired({ now: at(1_061), maxAttempts: MAX_ATTEMPTS }),
    ).toEqual({
      requeued: 0,
      failed: 1,
      transcriptionsGivenUp: [],
    });
    expect(store.getMedia(media.id)).toMatchObject({
      status: 'failed',
      failure: 'too-many-attempts',
    });
    expect(lease(1_100)).toBeNull();
  });

  it('leaves a lease alone until it actually expires', () => {
    queued();
    leased(0);
    expect(
      store.reapExpired({ now: at(60), maxAttempts: MAX_ATTEMPTS }),
    ).toEqual({
      requeued: 0,
      failed: 0,
      transcriptionsGivenUp: [],
    });
  });

  it('does not let a worker whose lease expired finish the job', () => {
    const media = queued();
    const stale = leased(0);
    store.reapExpired({ now: at(61), maxAttempts: MAX_ATTEMPTS });
    const fresh = leased(62);
    expect(
      store.completeTranscode({
        transcribeJobId: crypto.randomUUID(),
        ...owner(stale),
        durationMs: 1,
        now: at(63),
        rendition: rendition(media.id),
      }),
    ).toBe(false);
    expect(fresh.attempt).toBe(2);
    expect(store.getMedia(media.id)?.status).toBe('processing');
  });

  it('retries a failed item with a fresh attempt count', () => {
    const media = queued();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const job = leased(attempt);
      store.failJob({
        ...owner(job),
        failure: 'conversion-failed',
        detail: 'x',
        now: at(attempt),
        maxAttempts: MAX_ATTEMPTS,
      });
    }
    expect(store.retryMedia({ mediaId: media.id, now: at(10) })).toMatchObject({
      status: 'queued',
      failure: null,
    });
    expect(leased(11).attempt).toBe(1);
  });

  it('fails uploads abandoned before a moment', () => {
    const old = store.createMedia(aMedia({ now: at(0) }));
    const recent = store.createMedia(aMedia({ now: at(500) }));
    const done = queued({ now: at(1) });
    expect(store.abandonUploads({ olderThan: at(100), now: at(600) })).toEqual([
      old.id,
    ]);
    expect(store.getMedia(old.id)).toMatchObject({
      status: 'failed',
      failure: 'upload-abandoned',
    });
    expect(store.getMedia(recent.id)?.status).toBe('uploading');
    expect(store.getMedia(done.id)?.status).toBe('queued');
  });
});

describe('openMediaDatabase', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kbchat-media-db-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates the folder, uses WAL and applies the migrations once', () => {
    const path = join(dir, 'nested', 'media.db');
    const db = openMediaDatabase(path, MEDIA_MIGRATIONS);
    expect(db.prepare('PRAGMA journal_mode').get()?.['journal_mode']).toBe(
      'wal',
    );
    expect(db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys']).toBe(1);
    expect(applyMigrations(db, MEDIA_MIGRATIONS)).toEqual([]);
    db.close();
    const reopened = openMediaDatabase(path, MEDIA_MIGRATIONS);
    expect(
      reopened.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.[
        'n'
      ],
    ).toBe(MEDIA_MIGRATIONS.length);
    reopened.close();
  });

  it('applies new migrations in order and rolls back a broken one', () => {
    const db = openMediaDatabase(':memory:', MEDIA_MIGRATIONS);
    const last = MEDIA_MIGRATIONS.length;
    const next = [
      {
        version: last + 2,
        name: 'c',
        sql: 'CREATE TABLE c (x INTEGER) STRICT;',
      },
      {
        version: last + 1,
        name: 'b',
        sql: 'CREATE TABLE b (x INTEGER) STRICT;',
      },
    ];
    expect(applyMigrations(db, [...MEDIA_MIGRATIONS, ...next])).toEqual([
      last + 1,
      last + 2,
    ]);
    const broken = {
      version: last + 3,
      name: 'd',
      sql: 'CREATE TABLE d (x INTEGER); BOOM;',
    };
    expect(() => applyMigrations(db, [broken])).toThrow();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'd'").get(),
    ).toBeUndefined();
    db.close();
  });

  it('refuses to open when a migration fails', () => {
    const broken = [{ version: 1, name: 'x', sql: 'NOT SQL' }];
    expect(() => openMediaDatabase(join(dir, 'media.db'), broken)).toThrow();
  });
});
