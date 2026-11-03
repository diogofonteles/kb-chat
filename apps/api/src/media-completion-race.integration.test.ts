import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsMediaFiles } from './adapters/media/fs-media-files.js';
import { openMediaDatabase } from './adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from './adapters/sqlite/media-migrations.js';
import { SqliteMediaStore } from './adapters/sqlite/sqlite-media-store.js';
import { WorkerService } from './modules/media/index.js';
import type { TranscodeResult } from './ports/media-store.js';

/** A store where a master removes the item right before the completion is recorded. */
class RemovedWhileCompleting extends SqliteMediaStore {
  override completeTranscode(result: TranscodeResult): boolean {
    this.deleteMedia(result.rendition.mediaId);
    return super.completeTranscode(result);
  }
}

/** A store where the lease expires (another worker took the job) before the completion. */
class LeaseLostBeforeCompleting extends SqliteMediaStore {
  override heartbeat(): boolean {
    return false;
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kbchat-race-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function itemOn(store: SqliteMediaStore) {
  const files = new FsMediaFiles(dir);
  await files.assertWritable();
  const id = '11111111-1111-4111-8111-111111111111';
  store.createMedia({
    id,
    topic: 'hermetismo',
    title: 'x',
    author: null,
    legacyAuthorship: 'outros-autores',
    ownerPrincipal: 'owner',
    fileName: 'x.mp3',
    uploadBytes: 3,
    now: new Date(),
  });
  store.markUploaded({
    mediaId: id,
    jobId: crypto.randomUUID(),
    now: new Date(),
  });
  return { files, id };
}

describe('WorkerService completion race', () => {
  it('leaves no audio behind when the item is removed while the rendition moves in', async () => {
    const store = new RemovedWhileCompleting(
      openMediaDatabase(':memory:', MEDIA_MIGRATIONS),
    );
    const { files, id } = await itemOn(store);
    const service = new WorkerService({ store, files });
    const job = service.lease({ worker: 'vm', kinds: ['transcode'] });
    if (job?.kind !== 'transcode') throw new Error('no job');
    writeFileSync(join(dir, job.targetPath), 'aac');
    await expect(
      service.completeTranscode(job.id, {
        worker: 'vm',
        leaseId: job.leaseId,
        durationMs: 1,
        bytes: 3,
      }),
    ).rejects.toMatchObject({ code: 'MEDIA_CONFLICT' });
    expect(await files.stat(files.audioPath(id))).toBeNull();
    store.close();
  });

  it('removes its work file when the lease was lost before the completion', async () => {
    const store = new LeaseLostBeforeCompleting(
      openMediaDatabase(':memory:', MEDIA_MIGRATIONS),
    );
    const { files, id } = await itemOn(store);
    const service = new WorkerService({ store, files });
    const job = service.lease({ worker: 'vm', kinds: ['transcode'] });
    if (job?.kind !== 'transcode') throw new Error('no job');
    writeFileSync(join(dir, job.targetPath), 'aac');
    await expect(
      service.completeTranscode(job.id, {
        worker: 'vm',
        leaseId: job.leaseId,
        durationMs: 1,
        bytes: 3,
      }),
    ).rejects.toMatchObject({ code: 'MEDIA_CONFLICT' });
    expect(existsSync(join(dir, job.targetPath))).toBe(false);
    expect(await files.stat(files.audioPath(id))).toBeNull();
    store.close();
  });
});
