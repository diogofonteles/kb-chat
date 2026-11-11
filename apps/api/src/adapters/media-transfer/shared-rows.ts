import type { DatabaseSync } from 'node:sqlite';
import { insertMissingRows } from './copy-rows.js';
import type { ImportRun, SourceUnit } from './import-run.js';

/**
 * Rows a unit shares with others (the collection's speakers and subjects) and the rows of
 * the whole library (terms, learning switches, people's own rows). Production wins wherever
 * it already has the row; nothing here is ever deleted.
 */
const IDS = '(SELECT value FROM json_each(:ids))';

/** The temporary maps every copy reads (copy-rows.ts). */
export function createMaps(db: DatabaseSync): void {
  db.exec(`
    CREATE TEMP TABLE principal_map (src TEXT PRIMARY KEY, dst TEXT NOT NULL);
    CREATE TEMP TABLE speaker_map (src TEXT PRIMARY KEY, dst TEXT NOT NULL);
    CREATE TEMP TABLE subject_map (src TEXT PRIMARY KEY, dst TEXT NOT NULL);
    CREATE TEMP TABLE level_map (media_id TEXT PRIMARY KEY, level TEXT);
  `);
}

interface SharedTable {
  readonly table: 'media_speakers' | 'media_subjects';
  readonly map: 'speaker_map' | 'subject_map';
  /** The unit's references, as `SELECT <id>` over the package. */
  readonly refs: string;
  /**
   * Production's row taken for a package row: same id, or the same name in the collection.
   * Two lookups in a coalesce: Node 22's SQLite refuses an outer column in a subquery's ORDER BY.
   */
  readonly match: string;
}

const SPEAKERS: SharedTable = {
  table: 'media_speakers',
  map: 'speaker_map',
  refs: `SELECT speaker_id FROM src.media_voice_labels WHERE diarization_id IN
             (SELECT id FROM src.diarizations WHERE media_id IN ${IDS})
         UNION SELECT asker_speaker_id FROM src.media_tracks WHERE media_id IN ${IDS}
         UNION SELECT answerer_speaker_id FROM src.media_tracks WHERE media_id IN ${IDS}
         UNION SELECT asker_speaker_id FROM src.media_draft_tracks WHERE media_id IN ${IDS}
         UNION SELECT answerer_speaker_id FROM src.media_draft_tracks WHERE media_id IN ${IDS}
         UNION SELECT asker_speaker_id FROM src.media_track_archive WHERE media_id IN ${IDS}
         UNION SELECT answerer_speaker_id FROM src.media_track_archive WHERE media_id IN ${IDS}`,
  match: `coalesce((SELECT m.id FROM main.media_speakers m WHERE m.id = x.id),
            (SELECT m.id FROM main.media_speakers m WHERE m.collection = x.collection
               AND (m.name_key = x.name_key
                 OR (x.author_slug IS NOT NULL AND m.author_slug = x.author_slug))
             LIMIT 1))`,
};

const SUBJECTS: SharedTable = {
  table: 'media_subjects',
  map: 'subject_map',
  refs: `SELECT subject_id FROM src.media_subject_links WHERE media_id IN ${IDS}`,
  match: `coalesce((SELECT m.id FROM main.media_subjects m WHERE m.id = x.id),
            (SELECT m.id FROM main.media_subjects m
             WHERE m.collection = x.collection AND m.name_key = x.name_key LIMIT 1))`,
};

/** Maps each referenced package row to production's, inserting the ones it lacks. */
function ensureShared(
  db: DatabaseSync,
  shared: SharedTable,
  ids: string,
): void {
  const referenced = `x.id IN (${shared.refs})`;
  db.prepare(
    `INSERT OR REPLACE INTO temp.${shared.map} (src, dst)
     SELECT x.id, (${shared.match}) FROM src.${shared.table} x
     WHERE ${referenced} AND (${shared.match}) IS NOT NULL`,
  ).run({ ids });
  db.prepare(
    `INSERT INTO temp.${shared.map} (src, dst)
     SELECT x.id, x.id FROM src.${shared.table} x
     WHERE ${referenced} AND x.id NOT IN (SELECT src FROM temp.${shared.map})`,
  ).run({ ids });
  insertMissingRows(
    db,
    shared.table,
    `x.id IN (SELECT src FROM temp.${shared.map} WHERE src = dst)
     AND x.id NOT IN (SELECT id FROM main.${shared.table})`,
  );
}

export function ensureSharedRows(db: DatabaseSync, unit: SourceUnit): void {
  ensureShared(db, SPEAKERS, unit.ids);
  ensureShared(db, SUBJECTS, unit.ids);
}

/** People's own rows, only for people production has and media it has (BR-5). */
const PERSONAL: Readonly<Record<string, string>> = {
  media_preferences: '1',
  media_library_state: '1',
  media_progress: 'x.media_id IN (SELECT id FROM main.media)',
  media_bookmarks: 'x.media_id IN (SELECT id FROM main.media)',
  media_moved_bookmarks: `x.media_id IN (SELECT id FROM main.media)
    AND x.recording_id IN (SELECT id FROM main.media)
    AND x.bookmark_id IN (SELECT id FROM main.media_bookmarks)`,
};

const MAPPED = 'x.principal IN (SELECT src FROM temp.principal_map)';

export function copyPersonalRows(run: ImportRun): void {
  for (const [table, where] of Object.entries(PERSONAL)) {
    run.report.people.rows += insertMissingRows(
      run.db,
      table,
      `${MAPPED} AND ${where}`,
    );
    const skipped = run.db
      .prepare(`SELECT count(*) AS n FROM src.${table} x WHERE NOT (${MAPPED})`)
      .get();
    run.report.people.skippedRows += Number(skipped?.['n']);
  }
}

interface Term {
  readonly term: string;
  readonly source: string;
}

function latestTerms(
  db: DatabaseSync,
  schema: string,
): { version: number; terms: Term[] } {
  const version = Number(
    db
      .prepare(`SELECT coalesce(max(version), 0) AS v FROM ${schema}.terms`)
      .get()?.['v'],
  );
  const terms = db
    .prepare(
      `SELECT term, source FROM ${schema}.terms WHERE version = ? ORDER BY position`,
    )
    .all(version)
    .map((row) => ({
      term: String(row['term']),
      source: String(row['source']),
    }));
  return { version, terms };
}

/**
 * The Mac's terms production lacks (the masters' and the learned ones, ADR 0037) appended
 * to production's list as a new version; nothing when it already has them all.
 */
export function mergeTerms(run: ImportRun): void {
  const there = latestTerms(run.db, 'main');
  const known = new Set(there.terms.map((one) => one.term));
  const missing = latestTerms(run.db, 'src').terms.filter(
    (one) => !known.has(one.term),
  );
  if (missing.length === 0) return;
  const version = there.version + 1;
  run.db
    .prepare(
      `INSERT INTO main.term_versions (version, created_at, author_principal, author_name)
       VALUES (?, ?, NULL, 'Importação do Mac')`,
    )
    .run(version, run.now.toISOString());
  const insert = run.db.prepare(
    'INSERT INTO main.terms (version, position, term, source) VALUES (?, ?, ?, ?)',
  );
  [...there.terms, ...missing].forEach((one, index) =>
    insert.run(version, index + 1, one.term, one.source),
  );
  run.report.termsAdded = missing.length;
}

export function copyLearningSwitches(run: ImportRun): void {
  run.report.switchesAdded = insertMissingRows(
    run.db,
    'learning_switches',
    '1',
  );
}
