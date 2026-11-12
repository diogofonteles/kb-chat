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
  ImportFailure,
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
    const verify = verifyProduction(world.prod.media);
    expect(verify.ledgerMismatches).toEqual(['r1']);
    expect(verify.ok).toBe(true);
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

  it("BR-6: a level production set after the import stays, and does not hold the Mac's next change", async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    await moveOnce(world);
    onProd(world, (db) =>
      db
        .prepare(
          `UPDATE media SET level = 'alto', updated_at = '2026-11-11T21:00:00.000Z' WHERE id = 'r1'`,
        )
        .run(),
    );
    onMac(
      world,
      `UPDATE words SET text = 'vegetal' WHERE transcript_id = 't-r1' AND position = 0`,
    );

    const report = await moveOnce(world);

    expect(report.updated).toEqual(['r1']);
    onProd(world, (db) =>
      expect(
        db.prepare(`SELECT level FROM media WHERE id = 'r1'`).get()?.['level'],
      ).toBe('alto'),
    );
  });
});

describe("KBC-106: a track's own level belongs to production", () => {
  it("a track's own level and its draft's level set in production stay, and do not hold the Mac's next change", async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    onMac(
      world,
      `INSERT INTO media_draft_tracks (id, media_id, source, start_ms, end_ms, kind, title, created_at)
       VALUES ('mt-r1-t1', 'r1', 'manual', 0, 30000, 'talk', 'Faixa 1', '${AT}')`,
    );
    await moveOnce(world);
    onProd(world, (db) => {
      db.prepare(
        `UPDATE media SET level = 'alto', level_own = 1, updated_at = '2026-11-11T21:00:00.000Z' WHERE id = 'r1-t1'`,
      ).run();
      db.prepare(
        `UPDATE media_draft_tracks SET level = 'alto' WHERE id = 'mt-r1-t1'`,
      ).run();
    });
    onMac(
      world,
      `UPDATE words SET text = 'vegetal' WHERE transcript_id = 't-r1' AND position = 0`,
    );

    const report = await moveOnce(world);

    expect(report.updated).toEqual(['r1']);
    onProd(world, (db) => {
      expect(
        db
          .prepare(`SELECT level, level_own FROM media WHERE id = 'r1-t1'`)
          .get(),
      ).toMatchObject({ level: 'alto', level_own: 1 });
      expect(
        db
          .prepare(`SELECT level FROM media_draft_tracks WHERE id = 'mt-r1-t1'`)
          .get()?.['level'],
      ).toBe('alto');
    });
  });

  it("QA-3: a new track from the Mac never lands below its recording's level in production; it follows it", async () => {
    const world = newWorld();
    const scale = {
      version: 1,
      scales: {
        udv: [
          { id: 'ci', code: 'CI' },
          { id: 'cdc', code: 'CDC' },
        ],
      },
    };
    writeJson(join(world.mac.state, 'access-levels.json'), scale);
    writeJson(join(world.prod.state, 'access-levels.json'), scale);
    seedRecording(world, { id: 'r1', level: 'ci' });
    await moveOnce(world);
    onProd(world, (db) =>
      db
        .prepare(`UPDATE media SET level = 'cdc' WHERE id IN ('r1', 'r1-t1')`)
        .run(),
    );
    const db = macDb(world);
    try {
      insertMedia(db, {
        id: 'r1-t2',
        topic: 'udv',
        title: 'Faixa 2',
        level: 'ci',
        parent: 'r1',
      });
      db.prepare(
        `INSERT INTO media_files (media_id, rendition, path, bytes, mime) VALUES ('r1-t2', 'audio', 'audio/r1.r1-t2.m4a', 10, 'audio/mp4')`,
      ).run();
    } finally {
      db.close();
    }
    writeFile(world.mac.media, 'audio/r1.r1-t2.m4a', 'audio of r1-t2');

    const report = await moveOnce(world);

    expect(report.updated).toEqual(['r1']);
    onProd(world, (prod) =>
      expect({
        ...prod
          .prepare(`SELECT level, level_own FROM media WHERE id = 'r1-t2'`)
          .get(),
      }).toEqual({ level: 'cdc', level_own: 0 }),
    );
  });

  it("a draft's level the production scale lacks arrives as the recording's", async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    onMac(
      world,
      `INSERT INTO media_draft_tracks (id, media_id, source, start_ms, end_ms, kind, title, level, created_at)
       VALUES ('mt-r1-t1', 'r1', 'manual', 0, 30000, 'talk', 'Faixa 1', 'cdc', '${AT}')`,
    );
    await moveOnce(world);
    onProd(world, (db) =>
      expect(
        db
          .prepare(`SELECT level FROM media_draft_tracks WHERE id = 'mt-r1-t1'`)
          .get()?.['level'],
      ).toBeNull(),
    );
  });
});

/** What never leaves the Mac (spec "Não vai", ADR 0032), as rows of the package's database. */
const STAYS_ON_THE_MAC = [
  'voice_consents',
  'voice_consent_evidence',
  'voice_profiles',
  'voice_profile_sources',
  'voice_profile_suggestions',
  'transcribers',
  'media_spend',
  'media_settings',
  'groq_chunks',
  'kb_publish_jobs',
  'media_document_removals',
  'vault_syncs',
  'media_level_seeds',
  'media_imports',
];

function seedWhatStays(world: World): void {
  const db = macDb(world);
  try {
    db.exec(`
      INSERT INTO voice_consents (id, profile_id, collection, speaker_id, speaker_name, subject, granted_by,
        granted_on, method, purpose, text_version, registered_by, registered_at)
      VALUES ('c1', 'vp1', 'udv', 'sp-hilton', 'Mestre Hilton', 'living', 'Hilton', '2026-11-01', 'email',
        'suggest-names-when-editing', 2, 'owner', '${AT}');
      INSERT INTO voice_consent_evidence (consent_id, kind, sealed) VALUES ('c1', 'text', 'sealed-evidence');
      INSERT INTO voice_profiles (id, consent_id, speaker_id, collection, model, created_at, updated_at)
      VALUES ('vp1', 'c1', 'sp-hilton', 'udv', 'm', '${AT}', '${AT}');
      INSERT INTO voice_profile_sources (profile_id, diarization_id, voice) VALUES ('vp1', 'd-r1', 1);
      INSERT INTO voice_profile_suggestions (diarization_id, voice, profile_id, similarity) VALUES ('d-r1', 1, 'vp1', 0.9);
      INSERT INTO jobs (id, media_id, kind, status, attempts, created_at, updated_at, voice_profile_id)
      VALUES ('j-vp', 'r1', 'voice-profile', 'done', 1, '${AT}', '${AT}', 'vp1');
      INSERT INTO transcribers (id, name, kinds, token_hash, created_by, created_at)
      VALUES ('tr1', 'Mac', 'transcribe', 'token-hash-that-stays-on-the-mac', 'owner', '${AT}');
      INSERT INTO media_spend (id, kind, media_id, principal, reserved_usd, status, created_at)
      VALUES ('sp1', 'kb-publish', 'r1', 'owner', 0.1, 'settled', '${AT}');
      INSERT INTO media_settings (key, value, updated_by, updated_at) VALUES ('groq', 'on', 'owner', '${AT}');
      INSERT INTO groq_chunks (job_id, start_ms, end_ms, terms_version, result, created_at)
      VALUES ('j-x', 0, 10, 1, '{}', '${AT}');
      INSERT INTO kb_publish_jobs (id, topic, status, created_at, updated_at) VALUES ('kp1', 'udv', 'done', '${AT}', '${AT}');
      INSERT INTO media_document_removals (topic, path, media_id, created_at, updated_at)
      VALUES ('udv', 'raw/x.md', 'r1', '${AT}', '${AT}');
      INSERT INTO vault_syncs (id, worker, ok, detail, started_at, finished_at) VALUES ('vs1', 'mac', 1, 'ok', '${AT}', '${AT}');
      INSERT INTO media_level_seeds (root, level, rows, seeded_at) VALUES ('udv', 'base', 1, '${AT}');
    `);
  } finally {
    db.close();
  }
}

function packageDb(world: World): DatabaseSync {
  return new DatabaseSync(join(world.pkg, 'media.db'), { readOnly: true });
}

function editManifest(
  world: World,
  edit: (manifest: { parts: Record<string, unknown> }) => void,
): void {
  const path = join(world.pkg, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
    parts: Record<string, unknown>;
  };
  edit(manifest);
  writeJson(path, manifest);
}

describe('KBC-116 review and QA round 1', () => {
  it("AC-13 (QA F-1): the package's database holds nothing that stays on the Mac", async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    seedRecording(world, { id: 'r2', track: false });
    seedWhatStays(world);
    onMac(
      world,
      `INSERT INTO jobs (id, media_id, kind, status, attempts, lease_id, lease_until, heartbeat_at, worker, created_at, updated_at)
       VALUES ('j-l', 'r2', 'diarize', 'leased', 1, 'lease-1', 99, 98, 'mac', ?, ?)`,
      AT,
      AT,
    );

    await exportFromMac(world);

    const db = packageDb(world);
    try {
      for (const table of STAYS_ON_THE_MAC)
        expect([
          table,
          count(db, `SELECT count(*) AS n FROM ${table}`),
        ]).toEqual([table, 0]);
      expect(
        count(
          db,
          `SELECT count(*) AS n FROM jobs WHERE kind = 'voice-profile' OR lease_id IS NOT NULL
             OR lease_until IS NOT NULL OR heartbeat_at IS NOT NULL`,
        ),
      ).toBe(0);
      expect(count(db, `SELECT count(*) AS n FROM jobs WHERE id = 'j-l'`)).toBe(
        1,
      );
    } finally {
      db.close();
    }
    expect(
      readFileSync(join(world.pkg, 'media.db')).includes(
        'token-hash-that-stays-on-the-mac',
      ),
    ).toBe(false);
    const report = await importToProd(world);
    expect(report.held.map((one) => one.rootId)).toEqual(['r2']);
  });

  it('M1: what production recalculates by itself (waveform, silences) does not hold the next Mac edit', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    await moveOnce(world);
    onProd(world, (db) =>
      db.exec(`
        INSERT INTO media_waveforms (media_id, version, peaks, elapsed_ms, created_at)
        VALUES ('r1', 9, x'0102', 5, '${AT}');
        INSERT INTO media_silence_maps (media_id, rendition, detector_version, noise_db, min_silence_ms,
          interval_count, elapsed_ms, created_at)
        VALUES ('r1', 'audio', 9, -40, 500, 1, 5, '${AT}');
        INSERT INTO media_silences (media_id, start_ms, end_ms) VALUES ('r1', 100, 900);
      `),
    );
    onMac(
      world,
      `UPDATE words SET text = 'vegetal' WHERE transcript_id = 't-r1' AND position = 0`,
    );

    const report = await moveOnce(world);

    expect(report.held).toEqual([]);
    expect(report.updated).toEqual(['r1']);
    expect(verifyProduction(world.prod.media).ledgerMismatches).toEqual([]);
    onProd(world, (db) => {
      expect(
        count(
          db,
          `SELECT version AS n FROM media_waveforms WHERE media_id = 'r1'`,
        ),
      ).toBe(9);
      expect(count(db, 'SELECT count(*) AS n FROM media_silences')).toBe(1);
    });
  });

  it('M2: a column a later migration adds to a content table neither holds nor hides a Mac edit', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    await moveOnce(world);
    onMac(world, 'ALTER TABLE segments ADD COLUMN note TEXT');
    onProd(world, (db) => db.exec('ALTER TABLE segments ADD COLUMN note TEXT'));

    expect(verifyProduction(world.prod.media).ledgerMismatches).toEqual([]);
    expect((await moveOnce(world)).unchanged).toEqual(['r1']);

    onMac(
      world,
      `UPDATE words SET text = 'vegetal' WHERE transcript_id = 't-r1' AND position = 0`,
    );
    const edited = await moveOnce(world);
    expect(edited.held).toEqual([]);
    expect(edited.updated).toEqual(['r1']);
    expect((await importToProd(world)).unchanged).toEqual(['r1']);
  });

  it('M2: a production edit is still held after a column was added', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    await moveOnce(world);
    onMac(world, 'ALTER TABLE segments ADD COLUMN note TEXT');
    onProd(world, (db) => {
      db.exec('ALTER TABLE segments ADD COLUMN note TEXT');
      db.prepare(
        `UPDATE media SET title = 'Da produção' WHERE id = 'r1'`,
      ).run();
    });
    onMac(world, `UPDATE media SET title = 'Do Mac' WHERE id = 'r1'`);

    const report = await moveOnce(world);

    expect(report.held[0]?.reason).toBe(
      'mudou na produção desde a última importação',
    );
  });

  it('F-2 (FR-8): a dry run lists the files the real run would copy, with their bytes', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    await exportFromMac(world);

    const report = await importToProd(world, true);

    expect(report.files.copied.sort()).toEqual([
      'audio/r1.m4a',
      'audio/r1.r1-t1.m4a',
      'transcripts/r1/diarization.json',
      'transcripts/r1/raw.json',
    ]);
    expect(report.files.bytes).toBeGreaterThan(0);
    expect(
      listFiles(world.prod.media).filter(
        (path) => !path.startsWith('/media.db'),
      ),
    ).toEqual([]);
  });

  it('BR-7: authors of units an earlier run wrote still reach production on the next run', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    await moveOnce(world);
    writeJson(join(world.prod.state, 'authors.json'), {
      version: 1,
      collections: {},
    });

    const report = await importToProd(world);

    expect(report.unchanged).toEqual(['r1']);
    expect(report.authorsAdded).toEqual(['udv/mestre-gabriel']);
    expect((await importToProd(world)).authorsAdded).toEqual([]);
  });

  it("BR-3: a held unit gets none of the Mac's personal rows", async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    await moveOnce(world);
    onProd(world, (db) =>
      db
        .prepare(`UPDATE media SET title = 'Da produção' WHERE id = 'r1'`)
        .run(),
    );
    onMac(world, `UPDATE media SET title = 'Do Mac' WHERE id = 'r1'`);
    onMac(
      world,
      `INSERT INTO media_progress (principal, media_id, position_ms, updated_at) VALUES ('owner', 'r1', 777, ?)`,
      AT,
    );

    const report = await moveOnce(world);

    expect(report.held.map((one) => one.rootId)).toEqual(['r1']);
    onProd(world, (db) =>
      expect(count(db, 'SELECT count(*) AS n FROM media_progress')).toBe(0),
    );
  });

  it("the manifest must name the package's four parts and nothing outside it", async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    await exportFromMac(world);
    editManifest(world, (manifest) => {
      delete manifest.parts['media.db'];
    });
    await expect(importToProd(world)).rejects.toThrow();

    await exportFromMac(world);
    editManifest(world, (manifest) => {
      manifest.parts['../outside'] = manifest.parts['levels.json'];
    });
    await expect(importToProd(world)).rejects.toThrow();
    onProd(world, (db) =>
      expect(count(db, 'SELECT count(*) AS n FROM media')).toBe(0),
    );
  });

  it("the check names a track's cut file gone missing", async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    onMac(
      world,
      `UPDATE media_tracks SET cut_path = 'audio/r1.cut.m4a' WHERE media_id = 'r1'`,
    );
    writeFile(world.mac.media, 'audio/r1.cut.m4a', 'cut');
    await moveOnce(world);

    rmSync(join(world.prod.media, 'audio/r1.cut.m4a'));

    expect(verifyProduction(world.prod.media).missingFiles).toEqual([
      'audio/r1.cut.m4a',
    ]);
  });

  it('F-3: a copy cut short is reported by the check and cleared by the next real run', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    await moveOnce(world);
    writeFile(world.prod.media, 'audio/.1731355200000.importing', 'half');

    expect(verifyProduction(world.prod.media).staleFiles).toEqual([
      'audio/.1731355200000.importing',
    ]);
    await importToProd(world, true);
    expect(verifyProduction(world.prod.media).staleFiles).toHaveLength(1);
    await importToProd(world);
    expect(verifyProduction(world.prod.media).staleFiles).toEqual([]);
  });

  it('F-4: a unit that fails names itself and hands back the report so far', async () => {
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

    const failure = await moveOnce(world).then(
      () => null,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(ImportFailure);
    const error = failure as InstanceType<typeof ImportFailure>;
    expect(error.message).toContain('r2');
    expect(error.message).toContain('Gravação r2');
    expect(error.report.inserted).toEqual(['r1']);
  });

  it('a speaker and a subject production has under another id are its own, by name', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    onMac(
      world,
      `INSERT INTO media_subjects (id, collection, name, name_key, created_by, created_at)
       VALUES ('su-mac', 'udv', 'Vegetal', 'vegetal', 'owner', ?)`,
      AT,
    );
    onMac(
      world,
      `INSERT INTO media_subject_links (id, media_id, kind, subject_key, subject_id, source, status, created_at)
       VALUES ('l1', 'r1-t1', 'free', 'free:su-mac', 'su-mac', 'manual', 'accepted', ?)`,
      AT,
    );
    onProd(world, (db) =>
      db.exec(`
        INSERT INTO media_speakers (id, collection, name, name_key, created_by, created_at, updated_at)
        VALUES ('sp-prod', 'udv', 'Mestre Hilton', 'mestre hilton', 'owner', '${AT}', '${AT}');
        INSERT INTO media_subjects (id, collection, name, name_key, created_by, created_at)
        VALUES ('su-prod', 'udv', 'Vegetal', 'vegetal', 'owner', '${AT}');
      `),
    );

    await moveOnce(world);

    onProd(world, (db) => {
      expect(
        db
          .prepare(
            `SELECT group_concat(DISTINCT speaker_id) AS s FROM media_voice_labels`,
          )
          .get()?.['s'],
      ).toBe('sp-prod');
      expect(
        db.prepare(`SELECT answerer_speaker_id AS s FROM media_tracks`).get()?.[
          's'
        ],
      ).toBe('sp-prod');
      expect(count(db, `SELECT count(*) AS n FROM media_speakers`)).toBe(1);
      expect(
        db
          .prepare(
            `SELECT subject_id || ' ' || subject_key AS s FROM media_subject_links`,
          )
          .get()?.['s'],
      ).toBe('su-prod free:su-prod');
      expect(count(db, `SELECT count(*) AS n FROM media_subjects`)).toBe(1);
    });
  });

  it('a replacement brings a track the Mac added, with its file', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    await moveOnce(world);
    const db = macDb(world);
    try {
      insertMedia(db, {
        id: 'r1-t2',
        topic: 'udv',
        title: 'Faixa 2',
        level: null,
        parent: 'r1',
      });
      db.prepare(
        `INSERT INTO media_files (media_id, rendition, path, bytes, mime) VALUES ('r1-t2', 'audio', 'audio/r1.r1-t2.m4a', 10, 'audio/mp4')`,
      ).run();
      db.prepare(
        `INSERT INTO media_tracks (id, media_id, ordinal, start_ms, end_ms, kind, title, source, approved_by,
           approved_at, derived_media_id, cut_status)
         VALUES ('mt-r1-t2', 'r1', 2, 30000, 60000, 'talk', 'Faixa 2', 'ai', 'owner', ?, 'r1-t2', 'published')`,
      ).run(AT);
    } finally {
      db.close();
    }
    writeFile(world.mac.media, 'audio/r1.r1-t2.m4a', 'audio of t2');

    const report = await moveOnce(world);

    expect(report.updated).toEqual(['r1']);
    expect(report.files.copied).toEqual(['audio/r1.r1-t2.m4a']);
    onProd(world, (db) => {
      expect(
        count(
          db,
          `SELECT count(*) AS n FROM media WHERE parent_media_id = 'r1'`,
        ),
      ).toBe(2);
      expect(count(db, 'SELECT count(*) AS n FROM media_tracks')).toBe(2);
    });
  });

  it("a track summary the Mac removed leaves the library's 'about' index too", async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    onMac(
      world,
      `INSERT INTO media_track_subjects (media_id, summary, version, updated_at) VALUES ('r1-t1', 'resumo antigo', 1, ?)`,
      AT,
    );
    await moveOnce(world);
    onMac(world, `DELETE FROM media_track_subjects WHERE media_id = 'r1-t1'`);

    expect((await moveOnce(world)).updated).toEqual(['r1']);

    onProd(world, (db) =>
      expect(
        count(
          db,
          "SELECT count(*) AS n FROM track_about_fts WHERE track_about_fts MATCH 'antigo'",
        ),
      ).toBe(0),
    );
  });

  it('BR-9: a production database behind the package refuses before any migration runs on it', async () => {
    const world = newWorld();
    seedRecording(world, { id: 'r1' });
    onProd(world, (db) =>
      db.exec(
        `DROP TABLE media_imports; DELETE FROM schema_migrations WHERE version = (SELECT max(version) FROM schema_migrations)`,
      ),
    );
    await exportFromMac(world);

    await expect(importToProd(world)).rejects.toThrow(
      /media migrations differ/,
    );

    const db = new DatabaseSync(join(world.prod.media, 'media.db'), {
      readOnly: true,
    });
    try {
      expect(
        count(
          db,
          `SELECT count(*) AS n FROM sqlite_master WHERE name = 'media_imports'`,
        ),
      ).toBe(0);
    } finally {
      db.close();
    }
  });
});
