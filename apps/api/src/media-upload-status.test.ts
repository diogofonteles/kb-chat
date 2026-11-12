import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import { createMediaRequestSchema } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { FsMediaFiles } from './adapters/media/fs-media-files.js';
import { openMediaDatabase } from './adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from './adapters/sqlite/media-migrations.js';
import { SqliteListeningStore } from './adapters/sqlite/sqlite-listening-store.js';
import { SqliteMediaStore } from './adapters/sqlite/sqlite-media-store.js';
import type { MediaFilesPort } from './ports/media-files.js';
import {
  MediaService,
  type MediaActor,
} from './modules/media/media-service.js';

/**
 * Where a resumable upload stands when two status reads meet (KBC-118, ADR 0033). The
 * interleavings are forced with barriers on the files port, never with time.
 */

const AUDIO = Buffer.from('ID3 fake mp3 bytes for the upload test');
const OWNER: MediaActor = {
  principal: 'owner@example.com',
  isMaster: true,
  canUpload: true,
  quotaBytes: null,
  canSee: () => true,
  levelsIn: () => null,
};

/** A promise opened from outside. */
function barrier(): { readonly wait: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open: () => open() };
}

interface World {
  readonly service: MediaService;
  readonly store: SqliteMediaStore;
  readonly db: DatabaseSync;
  readonly id: string;
  readonly keep: (bytes: Buffer) => void;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** The real service, store and disk; `wrap` changes what the service sees of the disk. */
function worldWith(wrap: (files: FsMediaFiles) => MediaFilesPort): World {
  const dir = mkdtempSync(join(tmpdir(), 'kbchat-upload-status-'));
  dirs.push(dir);
  const db = openMediaDatabase(':memory:', MEDIA_MIGRATIONS);
  const store = new SqliteMediaStore(db);
  const disk = new FsMediaFiles(dir);
  const service = new MediaService({
    store,
    files: wrap(disk),
    listening: new SqliteListeningStore(db),
    hasTopic: () => true,
    authorOf: () => null,
  });
  const sha256 = createHash('sha256').update(AUDIO).digest('hex');
  const { id } = service.create(
    OWNER,
    'hermetismo',
    createMediaRequestSchema.parse({
      title: 'Palestra de 1998',
      author: null,
      fileName: 'palestra.mp3',
      bytes: AUDIO.length,
      sha256,
    }),
  );
  const keep = (bytes: Buffer) => {
    mkdirSync(join(dir, 'uploads'), { recursive: true });
    writeFileSync(join(dir, `${disk.uploadPath(id)}.part`), bytes);
  };
  return { service, store, db, id, keep };
}

/** Files whose second `uploadOffset` reads the disk only once `gate` opens. */
function secondReadWaitsFor(gate: Promise<void>) {
  return (files: FsMediaFiles): MediaFilesPort => {
    let reads = 0;
    return Object.assign(Object.create(files) as FsMediaFiles, {
      async uploadOffset(mediaId: string) {
        reads += 1;
        if (reads === 2) await gate;
        return files.uploadOffset(mediaId);
      },
    });
  };
}

const jobsOf = (db: DatabaseSync, id: string) =>
  Number(
    db.prepare('SELECT count(*) AS n FROM jobs WHERE media_id = ?').get(id)?.[
      'n'
    ],
  );

describe('uploadStatus with two status reads at once (KBC-118)', () => {
  it("answers the whole length to a second status read whose stat lands after the first one's rename (AC-1)", async () => {
    const renamed = barrier();
    const world = worldWith((files) => {
      const gated = secondReadWaitsFor(renamed.wait)(files);
      return Object.assign(gated, {
        async finishUpload(mediaId: string) {
          await files.finishUpload(mediaId);
          renamed.open();
        },
      });
    });
    world.keep(AUDIO);
    const both = await Promise.all([
      world.service.uploadStatus(OWNER, world.id),
      world.service.uploadStatus(OWNER, world.id),
    ]);
    expect(both).toEqual([
      { offset: AUDIO.length, length: AUDIO.length },
      { offset: AUDIO.length, length: AUDIO.length },
    ]);
    expect(world.store.getMedia(world.id)?.status).toBe('queued');
    expect(jobsOf(world.db, world.id)).toBe(1);
  });

  it('answers the whole length to a second status read whose stat lands after the first one ended (AC-2)', async () => {
    const firstAnswered = barrier();
    const world = worldWith(secondReadWaitsFor(firstAnswered.wait));
    world.keep(AUDIO);
    const first = world.service.uploadStatus(OWNER, world.id);
    const second = world.service.uploadStatus(OWNER, world.id);
    expect(await first).toEqual({
      offset: AUDIO.length,
      length: AUDIO.length,
    });
    firstAnswered.open();
    expect(await second).toEqual({
      offset: AUDIO.length,
      length: AUDIO.length,
    });
    expect(jobsOf(world.db, world.id)).toBe(1);
  });

  it('starts both over when the whole file kept is not the one announced (AC-3)', async () => {
    const discarded = barrier();
    const world = worldWith((files) => {
      const gated = secondReadWaitsFor(discarded.wait)(files);
      return Object.assign(gated, {
        async discardUpload(mediaId: string) {
          await files.discardUpload(mediaId);
          discarded.open();
        },
      });
    });
    world.keep(Buffer.alloc(AUDIO.length, 7));
    const both = await Promise.all([
      world.service.uploadStatus(OWNER, world.id),
      world.service.uploadStatus(OWNER, world.id),
    ]);
    expect(both).toEqual([
      { offset: 0, length: AUDIO.length },
      { offset: 0, length: AUDIO.length },
    ]);
    expect(world.store.getMedia(world.id)?.status).toBe('uploading');
  });

  it('answers a status read during a part without waiting for it (AC-4)', async () => {
    const partEnds = barrier();
    const world = worldWith((files) =>
      Object.assign(Object.create(files) as FsMediaFiles, {
        async appendUpload() {
          await partEnds.wait;
          return 10;
        },
      }),
    );
    world.keep(AUDIO.subarray(0, 10));
    const part = world.service.receivePart(OWNER, world.id, {
      body: Readable.from([]),
      offset: 10,
    });
    expect(await world.service.uploadStatus(OWNER, world.id)).toEqual({
      offset: 10,
      length: AUDIO.length,
    });
    partEnds.open();
    expect(await part).toBe(10);
  });
});
