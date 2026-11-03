import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsMediaFiles } from './adapters/media/fs-media-files.js';
import { openMediaDatabase } from './adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from './adapters/sqlite/media-migrations.js';
import { SqliteMediaStore } from './adapters/sqlite/sqlite-media-store.js';
import { createLogger } from './logger.js';
import {
  JOB_LEASE_MS,
  MediaJanitor,
  UPLOAD_ABANDON_MS,
} from './modules/media/index.js';

const T0 = new Date('2026-10-28T12:00:00.000Z');
let dir: string;
let store: SqliteMediaStore;
let files: FsMediaFiles;

function janitorAt(now: Date, log = createLogger('silent')) {
  return new MediaJanitor({ store, files, log, now: () => now });
}

async function uploading(id: string, at: Date) {
  store.createMedia({
    id,
    topic: 'hermetismo',
    title: 'Palestra',
    author: null,
    legacyAuthorship: 'outros-autores',
    ownerPrincipal: 'owner',
    fileName: 'a.mp3',
    uploadBytes: 3,
    now: at,
  });
  await files.saveUpload({
    mediaId: id,
    body: Readable.from([Buffer.from('abc')]),
    expectedBytes: 3,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kbchat-janitor-'));
  store = new SqliteMediaStore(openMediaDatabase(':memory:', MEDIA_MIGRATIONS));
  files = new FsMediaFiles(dir);
  await files.assertWritable();
});
afterEach(() => {
  vi.useRealTimers();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MediaJanitor', () => {
  it('requeues a job whose worker stopped beating', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    await uploading(id, T0);
    store.markUploaded({ mediaId: id, jobId: crypto.randomUUID(), now: T0 });
    store.leaseJob({
      kinds: ['transcode'],
      worker: 'vm',
      now: T0,
      leaseMs: JOB_LEASE_MS,
    });
    const later = new Date(T0.getTime() + JOB_LEASE_MS + 1);
    expect(await janitorAt(later).sweep()).toEqual({
      requeued: 1,
      failed: 0,
      abandoned: 0,
    });
    expect(store.getMedia(id)?.status).toBe('queued');
  });

  it('gives up uploads left for a day and deletes their bytes', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    await uploading(id, T0);
    const nextDay = new Date(T0.getTime() + UPLOAD_ABANDON_MS + 1);
    const lines: string[] = [];
    const log = createLogger('info', {
      write: (line: string) => void lines.push(line),
    });
    expect(await janitorAt(nextDay, log).sweep()).toMatchObject({
      abandoned: 1,
    });
    expect(store.getMedia(id)).toMatchObject({
      status: 'failed',
      failure: 'upload-abandoned',
    });
    expect(await files.stat(files.uploadPath(id))).toBeNull();
    expect(lines.join('')).toContain('media janitor sweep');
  });

  it('does nothing and logs nothing when there is nothing to do', async () => {
    const lines: string[] = [];
    const log = createLogger('info', {
      write: (line: string) => void lines.push(line),
    });
    expect(await janitorAt(T0, log).sweep()).toEqual({
      requeued: 0,
      failed: 0,
      abandoned: 0,
    });
    expect(lines).toEqual([]);
  });

  it('sweeps on its interval until stopped, logging a failed sweep', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const log = createLogger('info', {
      write: (line: string) => void lines.push(line),
    });
    const janitor = janitorAt(T0, log);
    const sweep = vi
      .spyOn(janitor, 'sweep')
      .mockRejectedValueOnce(new Error('disk gone'));
    janitor.start(1_000);
    janitor.start(1_000); // starting again keeps a single timer
    await vi.advanceTimersByTimeAsync(2_500);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(lines.join('')).toContain('media janitor sweep failed');
    janitor.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});
