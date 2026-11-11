import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  exportPackage,
  importPackage,
  verifyProduction,
  type ImportReport,
} from './adapters/media-transfer/index.js';
import { openMediaDatabase } from './adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from './adapters/sqlite/media-migrations.js';

/**
 * KBC-116 (ADR 0038): the media library moves from the owner's Mac to production by a
 * verified package and an incremental import. Each test builds its own Mac (media folder,
 * app state) and its own production (media folder, app state, vault) in a private temp dir.
 */
const OWNER_EMAIL = 'owner@example.com';
const AT = '2026-11-01T10:00:00.000Z';

interface Side {
  readonly media: string;
  readonly state: string;
  readonly vault: string;
}
interface World {
  readonly mac: Side;
  readonly prod: Side;
  readonly pkg: string;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function side(root: string, name: string): Side {
  const at = (folder: string): string => {
    const path = join(root, name, folder);
    mkdirSync(path, { recursive: true });
    return path;
  };
  return { media: at('media'), state: at('state'), vault: at('vault') };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

function people(
  ...list: { email: string; sub?: string; id: string }[]
): unknown {
  return { version: 1, people: list };
}

function newWorld(): World {
  const root = mkdtempSync(join(tmpdir(), 'kbc116-'));
  roots.push(root);
  const world = {
    mac: side(root, 'mac'),
    prod: side(root, 'prod'),
    pkg: join(root, 'package'),
  };
  writeJson(
    join(world.mac.state, 'people.json'),
    people(
      { id: 'p-owner', email: OWNER_EMAIL, sub: 's-owner' },
      { id: 'p-ana', email: 'ana@example.com', sub: 's-ana' },
      { id: 'p-bia', email: 'bia@example.com', sub: 's-bia' },
    ),
  );
  writeJson(
    join(world.prod.state, 'people.json'),
    people(
      { id: 'q-owner', email: OWNER_EMAIL },
      { id: 'q-ana', email: 'ANA@example.com', sub: 's-ana-prod' },
    ),
  );
  writeJson(join(world.mac.state, 'authors.json'), {
    version: 1,
    collections: {
      udv: {
        main: 'mestre-gabriel',
        authors: [
          {
            slug: 'mestre-gabriel',
            name: 'Mestre Gabriel',
            createdBy: 'owner',
            createdAt: AT,
          },
        ],
      },
    },
  });
  for (const topic of ['hermetismo', 'udv', 'udv/palavra-do-mestre']) {
    mkdirSync(join(world.prod.vault, topic), { recursive: true });
    writeFileSync(
      join(world.prod.vault, topic, 'topic.yaml'),
      `title: ${topic}\n`,
    );
  }
  return world;
}

function macDb(world: World): DatabaseSync {
  return openMediaDatabase(join(world.mac.media, 'media.db'), MEDIA_MIGRATIONS);
}

function prodDb(world: World): DatabaseSync {
  return openMediaDatabase(
    join(world.prod.media, 'media.db'),
    MEDIA_MIGRATIONS,
  );
}

function writeFile(dir: string, path: string, content: string): void {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), content);
}

interface Recording {
  readonly id: string;
  readonly topic?: string;
  readonly level?: string | null;
  readonly track?: boolean;
}

function insertMedia(
  db: DatabaseSync,
  row: {
    id: string;
    topic: string;
    title: string;
    level: string | null;
    parent: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name, upload_bytes,
       status, duration_ms, bytes, created_at, updated_at, author, parent_media_id, parent_start_ms,
       parent_end_ms, track_ordinal, level)
     VALUES (?, ?, ?, 'outros-autores', 'owner', 'a.m4a', 10, 'ready', 60000, 10, ?, ?, 'mestre-gabriel', ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.topic,
    row.title,
    AT,
    AT,
    row.parent,
    row.parent ? 0 : null,
    row.parent ? 30000 : null,
    row.parent ? 1 : null,
    row.level,
  );
}

function insertTranscript(
  db: DatabaseSync,
  mediaId: string,
  raw: string,
): void {
  db.prepare(
    `INSERT INTO transcripts (id, media_id, version, provider, model, parameters, parameters_version,
       terms_version, vad, speech_ratio, elapsed_ms, raw_path, filter_version, confidence_version,
       confidence, word_count, removed_words, low_words, created_at)
     VALUES (?, ?, 1, 'mac', 'large-v3', '{}', '1', 1, 'applied', 0.9, 100, ?, 1, 1, 'normal', 2, 0, 0, ?)`,
  ).run(`t-${mediaId}`, mediaId, raw, AT);
  db.prepare(
    `INSERT INTO segments (transcript_id, position, start_ms, end_ms, text) VALUES (?, 0, 0, 2000, 'a hoasca do rei')`,
  ).run(`t-${mediaId}`);
  const word = db.prepare(
    `INSERT INTO words (transcript_id, position, segment_position, start_ms, end_ms, text) VALUES (?, ?, 0, ?, ?, ?)`,
  );
  word.run(`t-${mediaId}`, 0, 0, 900, 'hoasca');
  word.run(`t-${mediaId}`, 1, 900, 2000, 'rei');
  db.prepare(
    `INSERT INTO segments_fts (rowid, text) SELECT rowid, text FROM segments WHERE transcript_id = ?`,
  ).run(`t-${mediaId}`);
}

function insertVoices(db: DatabaseSync, mediaId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO media_speakers (id, collection, name, name_key, created_by, created_at, updated_at)
     VALUES ('sp-hilton', 'udv', 'Mestre Hilton', 'mestre hilton', 'owner', ?, ?)`,
  ).run(AT, AT);
  db.prepare(
    `INSERT INTO diarizations (id, media_id, version, transcript_id, engine, model, parameters, parameters_version,
       voice_count, elapsed_ms, raw_path, derivation_version, created_at)
     VALUES (?, ?, 1, ?, 'senko', 'm', '{}', '1', 1, 10, ?, 1, ?)`,
  ).run(
    `d-${mediaId}`,
    mediaId,
    `t-${mediaId}`,
    `transcripts/${mediaId}/diarization.json`,
    AT,
  );
  db.prepare(
    `INSERT INTO media_voice_labels (diarization_id, voice, speaker_id) VALUES (?, 1, 'sp-hilton')`,
  ).run(`d-${mediaId}`);
}

function insertTrackRow(
  db: DatabaseSync,
  recording: string,
  track: string,
): void {
  db.prepare(
    `INSERT INTO media_tracks (id, media_id, ordinal, start_ms, end_ms, kind, title, source,
       answerer_speaker_id, approved_by, approved_at, derived_media_id, cut_status)
     VALUES (?, ?, 1, 0, 30000, 'talk', 'Faixa 1', 'ai', 'sp-hilton', 'owner', ?, ?, 'published')`,
  ).run(`mt-${track}`, recording, AT, track);
  db.prepare(
    `INSERT INTO jobs (id, media_id, kind, status, attempts, lease_id, worker, created_at, updated_at)
     VALUES (?, ?, 'cut', 'done', 1, 'lease-x', 'mac', ?, ?)`,
  ).run(`j-${track}`, track, AT, AT);
  db.prepare(
    `INSERT INTO media_documents (media_id, topic, path, desired_sha256, published_sha256, published_at, state,
       attempts, updated_at, live_sha256, live_at)
     VALUES (?, 'udv', ?, ?, ?, ?, 'published', 0, ?, ?, ?)`,
  ).run(
    track,
    `raw/media/${recording}/${track}.md`,
    'a'.repeat(64),
    'a'.repeat(64),
    AT,
    AT,
    'a'.repeat(64),
    AT,
  );
}

/** A recording on the Mac with a transcript, a separation, a track and the files they name. */
function seedRecording(world: World, recording: Recording): void {
  const db = macDb(world);
  const topic = recording.topic ?? 'udv';
  try {
    insertMedia(db, {
      id: recording.id,
      topic,
      title: `Gravação ${recording.id}`,
      level: recording.level ?? null,
      parent: null,
    });
    db.prepare(
      `INSERT INTO media_files (media_id, rendition, path, bytes, mime) VALUES (?, 'audio', ?, 10, 'audio/mp4')`,
    ).run(recording.id, `audio/${recording.id}.m4a`);
    writeFile(
      world.mac.media,
      `audio/${recording.id}.m4a`,
      `audio of ${recording.id}`,
    );
    insertTranscript(db, recording.id, `transcripts/${recording.id}/raw.json`);
    writeFile(
      world.mac.media,
      `transcripts/${recording.id}/raw.json`,
      `{"id":"${recording.id}"}`,
    );
    insertVoices(db, recording.id);
    writeFile(
      world.mac.media,
      `transcripts/${recording.id}/diarization.json`,
      '{}',
    );
    if (recording.track === false) return;
    const track = `${recording.id}-t1`;
    insertMedia(db, {
      id: track,
      topic,
      title: 'Faixa 1',
      level: recording.level ?? null,
      parent: recording.id,
    });
    db.prepare(
      `INSERT INTO media_files (media_id, rendition, path, bytes, mime) VALUES (?, 'audio', ?, 10, 'audio/mp4')`,
    ).run(track, `audio/${recording.id}.${track}.m4a`);
    writeFile(
      world.mac.media,
      `audio/${recording.id}.${track}.m4a`,
      `audio of ${track}`,
    );
    insertTrackRow(db, recording.id, track);
  } finally {
    db.close();
  }
}

function onMac(
  world: World,
  sql: string,
  ...values: (string | number | null)[]
): void {
  const db = macDb(world);
  try {
    db.prepare(sql).run(...values);
  } finally {
    db.close();
  }
}

function onProd<T>(world: World, read: (db: DatabaseSync) => T): T {
  const db = prodDb(world);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

async function exportFromMac(world: World): Promise<void> {
  await exportPackage({
    mediaDir: world.mac.media,
    stateDir: world.mac.state,
    ownerEmail: OWNER_EMAIL,
    out: world.pkg,
  });
}

function importToProd(world: World, dryRun = false): Promise<ImportReport> {
  return importPackage({
    packageDir: world.pkg,
    mediaDir: world.prod.media,
    stateDir: world.prod.state,
    vaultDir: world.prod.vault,
    ownerEmail: OWNER_EMAIL,
    dryRun,
    now: new Date('2026-11-11T20:00:00.000Z'),
  });
}

async function moveOnce(world: World): Promise<ImportReport> {
  await exportFromMac(world);
  return importToProd(world);
}

const count = (db: DatabaseSync, sql: string): number =>
  Number(db.prepare(sql).get()?.['n']);

function snapshot(world: World): string {
  return onProd(world, (db) =>
    JSON.stringify(
      [
        'media',
        'transcripts',
        'segments',
        'words',
        'media_tracks',
        'media_imports',
        'media_progress',
        'media_bookmarks',
        'terms',
      ].map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all(),
      ),
    ),
  );
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length))
    .sort();
}

describe('moving the media library from the Mac to production (KBC-116)', () => {
  it('AC-1: a clean production gets every media, its transcript, tracks and files', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    seedRecording(world, { id: 'r2', topic: 'hermetismo', track: false });

    const report = await moveOnce(world);

    expect(report.inserted.sort()).toEqual(['r1', 'r2']);
    expect(report.held).toEqual([]);
    expect(report.verify?.ok).toBe(true);
    onProd(world, (db) => {
      expect(count(db, 'SELECT count(*) AS n FROM media')).toBe(3);
      expect(count(db, 'SELECT count(*) AS n FROM media_imports')).toBe(2);
      expect(count(db, 'SELECT count(*) AS n FROM media_tracks')).toBe(1);
      expect(
        count(
          db,
          "SELECT count(*) AS n FROM segments_fts WHERE segments_fts MATCH 'hoasca'",
        ),
      ).toBe(2);
      expect(
        count(
          db,
          "SELECT count(*) AS n FROM track_about_fts WHERE track_about_fts MATCH 'faixa'",
        ),
      ).toBe(1);
      expect(
        count(
          db,
          'SELECT count(*) AS n FROM media_voice_labels WHERE speaker_id IS NOT NULL',
        ),
      ).toBe(2);
    });
    expect(
      listFiles(world.prod.media).filter(
        (path) => !path.startsWith('/media.db'),
      ),
    ).toEqual([
      '/audio/r1.m4a',
      '/audio/r1.r1-t1.m4a',
      '/audio/r2.m4a',
      '/transcripts/r1/diarization.json',
      '/transcripts/r1/raw.json',
      '/transcripts/r2/diarization.json',
      '/transcripts/r2/raw.json',
    ]);
    expect(readFileSync(join(world.prod.media, 'audio/r1.m4a'), 'utf8')).toBe(
      'audio of r1',
    );
  });

  it('AC-2: importing the same package again changes nothing', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    await moveOnce(world);
    const before = snapshot(world);

    const again = await importToProd(world);

    expect(again.inserted).toEqual([]);
    expect(again.updated).toEqual([]);
    expect(again.unchanged).toEqual(['r1']);
    expect(again.files.copied).toEqual([]);
    expect(snapshot(world)).toBe(before);
  });

  it('AC-3: a new recording on the Mac is the only thing the next run takes', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    await moveOnce(world);
    seedRecording(world, { id: 'r3', topic: 'udv/palavra-do-mestre' });

    const report = await moveOnce(world);

    expect(report.inserted).toEqual(['r3']);
    expect(report.unchanged).toEqual(['r1']);
    expect(report.files.copied.sort()).toEqual([
      'audio/r3.m4a',
      'audio/r3.r3-t1.m4a',
      'transcripts/r3/diarization.json',
      'transcripts/r3/raw.json',
    ]);
  });

  it("AC-4: a correction on the Mac replaces the unit's content and keeps people's progress", async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    await moveOnce(world);
    onProd(world, (db) =>
      db
        .prepare(
          `INSERT INTO media_progress (principal, media_id, position_ms, updated_at) VALUES ('owner', 'r1', 1234, ?)`,
        )
        .run(AT),
    );
    onMac(
      world,
      `UPDATE words SET text = 'vegetal' WHERE transcript_id = 't-r1' AND position = 0`,
    );
    onMac(
      world,
      `UPDATE segments SET text = 'a vegetal do rei' WHERE transcript_id = 't-r1'`,
    );

    const report = await moveOnce(world);

    expect(report.updated).toEqual(['r1']);
    expect(report.verify?.ok).toBe(true);
    onProd(world, (db) => {
      expect(
        db
          .prepare(
            `SELECT text FROM words WHERE transcript_id = 't-r1' AND position = 0`,
          )
          .get()?.['text'],
      ).toBe('vegetal');
      expect(
        count(
          db,
          "SELECT count(*) AS n FROM segments_fts WHERE segments_fts MATCH 'vegetal'",
        ),
      ).toBe(1);
      expect(
        count(
          db,
          "SELECT count(*) AS n FROM segments_fts WHERE segments_fts MATCH 'hoasca'",
        ),
      ).toBe(0);
      expect(
        count(
          db,
          `SELECT position_ms AS n FROM media_progress WHERE media_id = 'r1'`,
        ),
      ).toBe(1234);
    });
  });

  it('AC-5: a unit changed in production is held and keeps its change', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    await moveOnce(world);
    onProd(world, (db) =>
      db
        .prepare(
          `UPDATE media SET title = 'Título da produção' WHERE id = 'r1'`,
        )
        .run(),
    );
    onMac(world, `UPDATE media SET title = 'Título do Mac' WHERE id = 'r1'`);

    const report = await moveOnce(world);

    expect(report.held).toEqual([
      {
        rootId: 'r1',
        title: 'Título do Mac',
        reason: 'mudou na produção desde a última importação',
      },
    ]);
    onProd(world, (db) =>
      expect(
        db.prepare(`SELECT title FROM media WHERE id = 'r1'`).get()?.['title'],
      ).toBe('Título da produção'),
    );
  });

  it('AC-6: a media with a level and no scale in production is held', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1', level: 'qm' });
    seedRecording(world, { id: 'r2', topic: 'hermetismo', track: false });

    const report = await moveOnce(world);

    expect(report.held).toEqual([
      {
        rootId: 'r1',
        title: 'Gravação r1',
        reason: 'escala ausente na produção: udv',
      },
    ]);
    expect(report.inserted).toEqual(['r2']);
    onProd(world, (db) =>
      expect(
        count(db, `SELECT count(*) AS n FROM media WHERE id LIKE 'r1%'`),
      ).toBe(0),
    );
  });

  it("AC-7: a level production's scale lacks arrives as no level; one it has is kept", async () => {
    const world = newWorld();
    writeJson(join(world.mac.state, 'access-levels.json'), {
      version: 1,
      scales: { udv: [{ id: 'qm', code: 'QM' }] },
    });
    writeJson(join(world.prod.state, 'access-levels.json'), {
      version: 1,
      scales: {
        udv: [
          { id: 'ci', code: 'CI' },
          { id: 'qm-2', code: 'QM' },
        ],
        hermetismo: [],
      },
    });
    seedRecording(world, { id: 'r1', level: 'qm' });
    seedRecording(world, { id: 'r2', level: 'ci' });

    const report = await moveOnce(world);

    expect(report.inserted.sort()).toEqual(['r1', 'r2']);
    expect(
      report.levels.unassigned.map((one) => [one.mediaId, one.code]),
    ).toEqual([
      ['r1', 'QM'],
      ['r1-t1', 'QM'],
    ]);
    onProd(world, (db) =>
      expect(
        db
          .prepare(`SELECT id, level FROM media ORDER BY id`)
          .all()
          .map((row) => [row['id'], row['level']]),
      ).toEqual([
        ['r1', null],
        ['r1-t1', null],
        ['r2', 'ci'],
        ['r2-t1', 'ci'],
      ]),
    );
  });

  it('AC-8: a collection production lacks holds its units and writes nothing of them', async () => {
    const world = newWorld();
    rmSync(join(world.prod.vault, 'udv'), { recursive: true });
    seedRecording(world, { id: 'r1' });

    const report = await moveOnce(world);

    expect(report.held[0]?.reason).toBe(
      'acervo ausente na produção: udv (rode o sync do vault)',
    );
    onProd(world, (db) =>
      expect(count(db, 'SELECT count(*) AS n FROM media')).toBe(0),
    );
    expect(
      listFiles(world.prod.media).filter(
        (path) => !path.startsWith('/media.db'),
      ),
    ).toEqual([]);
  });

  it('AC-9: people are matched by e-mail; someone production lacks has no rows there', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    onMac(
      world,
      `INSERT INTO media_progress (principal, media_id, position_ms, updated_at) VALUES ('s-ana', 'r1', 50, ?)`,
      AT,
    );
    onMac(
      world,
      `INSERT INTO media_progress (principal, media_id, position_ms, updated_at) VALUES ('s-bia', 'r1', 60, ?)`,
      AT,
    );
    onMac(
      world,
      `INSERT INTO media_bookmarks (id, principal, media_id, position_ms, created_at, updated_at) VALUES ('b1', 's-bia', 'r1', 5, ?, ?)`,
      AT,
      AT,
    );

    const report = await moveOnce(world);

    expect(report.people.unmapped).toEqual(['bia@example.com']);
    expect(report.people.skippedRows).toBe(2);
    onProd(world, (db) => {
      expect(
        db
          .prepare(`SELECT principal, position_ms FROM media_progress`)
          .all()
          .map((row) => [row['principal'], row['position_ms']]),
      ).toEqual([['s-ana-prod', 50]]);
      expect(count(db, 'SELECT count(*) AS n FROM media_bookmarks')).toBe(0);
      expect(
        db.prepare(`SELECT owner_principal FROM media WHERE id = 'r1'`).get()?.[
          'owner_principal'
        ],
      ).toBe('owner');
    });
  });

  it('AC-10: a package file that does not match its manifest refuses the whole run', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    await exportFromMac(world);
    writeFileSync(join(world.pkg, 'files/audio/r1.m4a'), 'tampered');

    await expect(importToProd(world)).rejects.toThrow(
      "the package's files/audio/r1.m4a does not match its manifest",
    );
    expect(listFiles(world.prod.media)).toEqual([]);
  });

  it('AC-11: a dry run reports what would go and leaves production byte-identical', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    await moveOnce(world);
    seedRecording(world, { id: 'r3' });
    await exportFromMac(world);
    const before = readFileSync(join(world.prod.media, 'media.db'));
    const isMedia = (path: string): boolean => !path.startsWith('/media.db');
    const files = listFiles(world.prod.media).filter(isMedia);

    const report = await importToProd(world, true);

    expect(report.dryRun).toBe(true);
    expect(report.inserted).toEqual(['r3']);
    expect(
      readFileSync(join(world.prod.media, 'media.db')).equals(before),
    ).toBe(true);
    expect(listFiles(world.prod.media).filter(isMedia)).toEqual(files);
  });

  it('AC-12: different migrations on the two sides refuse before any change', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    await exportFromMac(world);
    onProd(world, (db) =>
      db
        .prepare(
          `INSERT INTO schema_migrations (version, name, applied_at) VALUES (999, 'from-the-future', ?)`,
        )
        .run(AT),
    );

    await expect(importToProd(world)).rejects.toThrow(
      /media migrations differ/,
    );
    onProd(world, (db) =>
      expect(count(db, 'SELECT count(*) AS n FROM media')).toBe(0),
    );
  });

  it('AC-13: voice prints, the revocation list and voice consents never travel', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    writeFile(world.mac.media, 'voice-prints/p1.sealed', 'secret print');
    writeFile(
      world.mac.media,
      'voice-revocations.list',
      'voice-revocations v1\n',
    );
    writeFile(world.mac.media, 'uploads/half.part', 'half an upload');
    onMac(
      world,
      `INSERT INTO voice_consents (id, profile_id, collection, speaker_id, speaker_name, subject, granted_by,
         granted_on, method, purpose, text_version, registered_by, registered_at)
       VALUES ('c1', 'vp1', 'udv', 'sp-hilton', 'Mestre Hilton', 'living', 'Hilton', '2026-11-01', 'email',
         'suggest-names-when-editing', 2, 'owner', ?)`,
      AT,
    );

    await moveOnce(world);

    expect(
      listFiles(world.pkg).some((path) => /voice|uploads/.test(path)),
    ).toBe(false);
    expect(
      listFiles(world.prod.media).some((path) => /voice|uploads/.test(path)),
    ).toBe(false);
    onProd(world, (db) =>
      expect(count(db, 'SELECT count(*) AS n FROM voice_consents')).toBe(0),
    );
  });

  it('AC-14: no work is queued in production for what the Mac did', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    onMac(
      world,
      `INSERT INTO jobs (id, media_id, kind, status, attempts, created_at, updated_at) VALUES ('j-q', 'r1', 'transcribe', 'failed', 4, ?, ?)`,
      AT,
      AT,
    );

    await moveOnce(world);

    onProd(world, (db) => {
      expect(
        count(
          db,
          `SELECT count(*) AS n FROM jobs WHERE status IN ('queued', 'leased')`,
        ),
      ).toBe(0);
      expect(
        count(
          db,
          `SELECT count(*) AS n FROM jobs WHERE lease_id IS NOT NULL OR heartbeat_at IS NOT NULL`,
        ),
      ).toBe(0);
      expect(count(db, 'SELECT count(*) AS n FROM jobs')).toBe(2);
      expect(count(db, 'SELECT count(*) AS n FROM transcribers')).toBe(0);
      expect(
        count(
          db,
          'SELECT count(*) AS n FROM media_documents WHERE live_sha256 IS NULL',
        ),
      ).toBe(1);
    });
  });

  it('AC-14: a recording still being worked on the Mac waits for the next run', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    onMac(
      world,
      `INSERT INTO jobs (id, media_id, kind, status, attempts, created_at, updated_at) VALUES ('j-q', 'r1', 'diarize', 'queued', 0, ?, ?)`,
      AT,
      AT,
    );

    const report = await moveOnce(world);

    expect(report.held[0]?.reason).toBe(
      'em andamento no Mac (vai na próxima execução)',
    );
  });

  it('AC-15: a production file with other content at an imported path holds the unit', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    writeFile(world.prod.media, 'audio/r1.m4a', 'production audio');

    const report = await moveOnce(world);

    expect(report.held[0]?.reason).toBe(
      'arquivo diferente na produção: audio/r1.m4a',
    );
    expect(readFileSync(join(world.prod.media, 'audio/r1.m4a'), 'utf8')).toBe(
      'production audio',
    );
  });

  it('BR-3: a track removed on the Mac holds the unit and nothing is deleted', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    await moveOnce(world);
    onMac(world, `DELETE FROM media WHERE id = 'r1-t1'`);

    const report = await moveOnce(world);

    expect(report.held[0]?.reason).toBe(
      'faixa removida no Mac (nada é apagado na produção)',
    );
    onProd(world, (db) =>
      expect(count(db, 'SELECT count(*) AS n FROM media')).toBe(2),
    );
  });

  it('BR-3: a media already in production without an import is held', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    onProd(world, (db) =>
      db
        .prepare(
          `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name, upload_bytes, status, created_at, updated_at) VALUES ('r1', 'udv', 'x', 'outros-autores', 'owner', 'a', 1, 'ready', ?, ?)`,
        )
        .run(AT, AT),
    );

    const report = await moveOnce(world);

    expect(report.held[0]?.reason).toBe(
      'já existe na produção sem registro de importação',
    );
  });

  it('BR-7: missing authors are appended and the ones production has are kept', async () => {
    const world = newWorld();
    writeJson(join(world.prod.state, 'authors.json'), {
      version: 1,
      collections: {
        hermetismo: {
          main: null,
          authors: [
            {
              slug: 'mestre-laercio',
              name: 'Mestre Laércio',
              createdBy: 'migration',
              createdAt: AT,
            },
          ],
        },
      },
    });
    seedRecording(world, { id: 'r1' });

    const report = await moveOnce(world);

    expect(report.authorsAdded).toEqual(['udv/mestre-gabriel']);
    const authors = JSON.parse(
      readFileSync(join(world.prod.state, 'authors.json'), 'utf8'),
    ) as {
      collections: Record<string, { main: string | null; authors: unknown[] }>;
    };
    expect(Object.keys(authors.collections).sort()).toEqual([
      'hermetismo',
      'udv',
    ]);
    expect(authors.collections['udv']?.main).toBe('mestre-gabriel');
  });

  it("learned terms production lacks go as a new version of production's list", async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    onMac(
      world,
      `INSERT INTO term_versions (version, created_at) VALUES (2, ?)`,
      AT,
    );
    onMac(
      world,
      `INSERT INTO terms (version, position, term, source) SELECT 2, position, term, source FROM terms WHERE version = 1`,
    );
    onMac(
      world,
      `INSERT INTO terms (version, position, term, source) VALUES (2, 900, 'Caianinha', 'learned')`,
    );

    const first = await moveOnce(world);
    const second = await importToProd(world);

    expect(first.termsAdded).toBe(1);
    expect(second.termsAdded).toBe(0);
    onProd(world, (db) =>
      expect(
        db
          .prepare(
            `SELECT source FROM terms WHERE term = 'Caianinha' AND version = (SELECT max(version) FROM terms)`,
          )
          .get()?.['source'],
      ).toBe('learned'),
    );
  });

  it('the standalone check passes after an import and names a file gone missing', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    await moveOnce(world);
    expect(verifyProduction(world.prod.media).ok).toBe(true);

    rmSync(join(world.prod.media, 'audio/r1.m4a'));

    expect(verifyProduction(world.prod.media).missingFiles).toEqual([
      'audio/r1.m4a',
    ]);
  });

  it('PD-08: a unit that fails half way leaves none of its rows and stops the run', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    seedRecording(world, { id: 'r2', track: false });
    onProd(world, (db) => {
      db.prepare(
        `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name, upload_bytes, status, created_at, updated_at)
         VALUES ('p1', 'udv', 'Da produção', 'outros-autores', 'owner', 'a', 1, 'ready', ?, ?)`,
      ).run(AT, AT);
      db.prepare(
        `INSERT INTO transcripts (id, media_id, version, provider, model, parameters, parameters_version, terms_version,
           vad, speech_ratio, elapsed_ms, raw_path, filter_version, confidence_version, confidence, word_count,
           removed_words, low_words, created_at)
         VALUES ('t-r2', 'p1', 1, 'mac', 'm', '{}', '1', 1, 'applied', 1, 1, '', 1, 1, 'normal', 0, 0, 0, ?)`,
      ).run(AT);
    });

    await expect(moveOnce(world)).rejects.toThrow(/constraint/i);

    onProd(world, (db) => {
      expect(count(db, `SELECT count(*) AS n FROM media WHERE id = 'r2'`)).toBe(
        0,
      );
      expect(
        count(
          db,
          `SELECT count(*) AS n FROM media_imports WHERE root_id = 'r2'`,
        ),
      ).toBe(0);
      expect(
        count(db, `SELECT count(*) AS n FROM media WHERE id LIKE 'r1%'`),
      ).toBe(2);
      expect(
        count(
          db,
          `SELECT count(*) AS n FROM media_imports WHERE root_id = 'r1'`,
        ),
      ).toBe(1);
    });
  });
});
