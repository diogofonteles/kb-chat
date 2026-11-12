import { existsSync } from 'node:fs';
import { copyFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inTransaction } from '../sqlite/media-database.js';
import { insertUnitRows, updateMediaRows } from './copy-rows.js';
import {
  digestColumns,
  digestColumnsText,
  unitFingerprint,
} from './fingerprint.js';
import type { ImportRun, SourceMedia, SourceUnit } from './import-run.js';
import { ensureSharedRows } from './shared-rows.js';
import { targetIds, type UnitPlan } from './unit-plan.js';
import {
  REWRITTEN_TABLES,
  UNIT_TABLES,
  type UnitTable,
} from './unit-tables.js';
import { rootOf } from './state-files.js';
import { TEMP_SUFFIX } from './temp-files.js';

/**
 * Writes one planned unit (ADR 0038 §3): its files first, each by a temporary name and a
 * rename and never over a file that is there, then all of its rows in one transaction.
 */
type Writing = Extract<UnitPlan, { kind: 'insert' | 'replace' }>;

/**
 * Copies the unit's files production lacks; the plan already refused a differing one. A dry
 * run lists them with the manifest's bytes and copies nothing (FR-8).
 */
export async function copyUnitFiles(
  run: ImportRun,
  plan: Writing,
): Promise<void> {
  for (const path of plan.files) {
    const to = join(run.mediaDir, path);
    if (existsSync(to)) {
      run.report.files.present += 1;
      continue;
    }
    if (!run.dryRun) {
      await mkdir(dirname(to), { recursive: true });
      const temp = join(dirname(to), `.${Date.now()}${TEMP_SUFFIX}`);
      await copyFile(run.pkg.fileOf(path), temp);
      await rename(temp, to);
    }
    run.report.files.copied.push(path);
    run.report.files.bytes += run.dryRun
      ? (run.pkg.manifest.files[path]?.bytes ?? 0)
      : (await stat(to)).size;
  }
}

/** The level each new media gets (BR-6): kept in production's scale, else none. */
function fillLevels(run: ImportRun, media: readonly SourceMedia[]): void {
  run.db.exec('DELETE FROM temp.level_map');
  const insert = run.db.prepare(
    'INSERT INTO temp.level_map (media_id, level) VALUES (?, ?)',
  );
  for (const item of media) {
    const root = rootOf(run.collections, item.topic);
    const kept =
      item.level !== null && run.scales.get(root)?.has(item.level) === true;
    insert.run(item.id, kept ? item.level : null);
    if (item.level !== null && !kept)
      run.report.levels.unassigned.push({
        mediaId: item.id,
        level: item.level,
        code: run.pkg.levelCodes[`${root}/${item.level}`] ?? null,
      });
  }
}

/** The levels of production's scale each media of the unit may hold (KBC-106 drafts). */
function fillScaleLevels(run: ImportRun, media: readonly SourceMedia[]): void {
  run.db.exec('DELETE FROM temp.scale_levels');
  const insert = run.db.prepare(
    'INSERT OR IGNORE INTO temp.scale_levels (media_id, level) VALUES (?, ?)',
  );
  for (const item of media)
    for (const level of run.scales.get(rootOf(run.collections, item.topic)) ??
      [])
      insert.run(item.id, level);
}

/** The draft levels production gave the unit, kept across a replacement (KBC-106). */
function keepDraftLevels(run: ImportRun, ids: string): void {
  run.db.exec('DELETE FROM temp.draft_levels');
  run.db
    .prepare(
      `INSERT INTO temp.draft_levels (id, level) SELECT id, level FROM main.media_draft_tracks
       WHERE media_id IN (SELECT value FROM json_each(:ids)) AND level IS NOT NULL`,
    )
    .run({ ids });
}

function restoreDraftLevels(run: ImportRun): void {
  run.db.exec(`
    UPDATE main.media_draft_tracks
    SET level = (SELECT d.level FROM temp.draft_levels d WHERE d.id = media_draft_tracks.id)
    WHERE id IN (SELECT id FROM temp.draft_levels)`);
}

/** The unit's current transcripts in the search index, as migration 12 builds it. */
function indexTranscripts(run: ImportRun, ids: string): void {
  run.db
    .prepare(
      `INSERT INTO main.segments_fts (rowid, text)
       SELECT s.rowid, s.text FROM main.segments s JOIN main.transcripts t ON t.id = s.transcript_id
       WHERE t.media_id IN (SELECT value FROM json_each(:ids))
         AND t.version = (SELECT max(version) FROM main.transcripts c WHERE c.media_id = t.media_id)`,
    )
    .run({ ids });
}

/** The unit's ledger line, both digests on today's set of columns (kept with them). */
export function recordLedger(
  run: ImportRun,
  unit: SourceUnit,
  fingerprint: string,
): void {
  const target = unitFingerprint(run.db, {
    schema: 'main',
    ids: targetIds(run, unit.rootId),
  });
  run.db
    .prepare(
      `INSERT INTO main.media_imports (root_id, source_digest, target_digest, digest_columns, package_id, imported_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (root_id) DO UPDATE SET source_digest = excluded.source_digest,
         target_digest = excluded.target_digest, digest_columns = excluded.digest_columns,
         package_id = excluded.package_id, imported_at = excluded.imported_at`,
    )
    .run(
      unit.rootId,
      fingerprint,
      target,
      digestColumnsText(digestColumns(run.db, 'main')),
      run.pkg.manifest.packageId,
      run.now.toISOString(),
    );
}

function insertRows(run: ImportRun, unit: SourceUnit): void {
  fillLevels(run, unit.media);
  fillScaleLevels(run, unit.media);
  ensureSharedRows(run.db, unit);
  for (const table of UNIT_TABLES)
    insertUnitRows(run.db, table, { ids: unit.ids });
}

function deleteRows(run: ImportRun, table: UnitTable, ids: string): void {
  const filter = {
    media_id: 'media_id IN',
    transcript: `transcript_id IN (SELECT id FROM main.transcripts WHERE media_id IN`,
    diarization: `diarization_id IN (SELECT id FROM main.diarizations WHERE media_id IN`,
    run: `run_id IN (SELECT id FROM main.media_proposal_runs WHERE media_id IN`,
    media: 'id IN',
  }[table.key];
  const close = table.key === 'media_id' || table.key === 'media' ? '' : ')';
  run.db
    .prepare(
      `DELETE FROM main.${table.name} WHERE ${filter} (SELECT value FROM json_each(:ids))${close}`,
    )
    .run({ ids });
}

/** Production's publication state of the unit's track documents, keeping what it saw live. */
function refreshDocuments(run: ImportRun, ids: string): void {
  const columns =
    'topic, path, desired_sha256, published_sha256, published_at, state, last_error, attempts, updated_at';
  run.db
    .prepare(
      `UPDATE main.media_documents SET (${columns}) =
         (SELECT ${columns} FROM src.media_documents x WHERE x.media_id = main.media_documents.media_id)
       WHERE media_id IN (SELECT value FROM json_each(:ids))
         AND media_id IN (SELECT media_id FROM src.media_documents)`,
    )
    .run({ ids });
}

/**
 * The unit's rows out of the search index first: segments go before their transcripts, so
 * the transcripts' own unindex trigger would find none, and a reused rowid would collide.
 */
function unindexTranscripts(run: ImportRun, ids: string): void {
  run.db
    .prepare(
      `DELETE FROM main.segments_fts WHERE rowid IN
         (SELECT s.rowid FROM main.segments s JOIN main.transcripts t ON t.id = s.transcript_id
          WHERE t.media_id IN (SELECT value FROM json_each(:ids)))`,
    )
    .run({ ids });
}

/** The library's "about" index of the unit's tracks, from the summaries they have now. */
function refreshAbout(run: ImportRun, ids: string): void {
  run.db
    .prepare(
      `UPDATE main.track_about_fts SET summary = coalesce(
         (SELECT s.summary FROM main.media_track_subjects s WHERE s.media_id = track_about_fts.media_id), '')
       WHERE media_id IN (SELECT value FROM json_each(:ids))`,
    )
    .run({ ids });
}

/** A replacement's insert of one table: derived rows only for media production lacks. */
function replaceTable(
  run: ImportRun,
  table: UnitTable,
  at: { readonly ids: string; readonly there: string },
): void {
  if (table.derived)
    insertUnitRows(run.db, table, {
      ids: at.ids,
      extra: 'x.media_id NOT IN (SELECT value FROM json_each(:there))',
      params: { there: at.there },
    });
  else
    insertUnitRows(run.db, table, {
      ids: at.ids,
      verb: table.fingerprint ? 'INSERT' : 'INSERT OR IGNORE',
    });
}

function replaceRows(run: ImportRun, unit: SourceUnit): void {
  const there = new Set(targetIds(run, unit.rootId));
  fillLevels(
    run,
    unit.media.filter((one) => !there.has(one.id)),
  );
  fillScaleLevels(run, unit.media);
  ensureSharedRows(run.db, unit);
  keepDraftLevels(run, unit.ids);
  unindexTranscripts(run, unit.ids);
  for (const table of [...REWRITTEN_TABLES].reverse())
    deleteRows(run, table, unit.ids);
  updateMediaRows(run.db, unit.ids);
  const [media, ...rest] = UNIT_TABLES;
  if (media)
    insertUnitRows(run.db, media, {
      ids: unit.ids,
      extra: 'x.id NOT IN (SELECT id FROM main.media)',
    });
  const known = JSON.stringify([...there]);
  for (const table of rest)
    replaceTable(run, table, { ids: unit.ids, there: known });
  restoreDraftLevels(run);
  refreshDocuments(run, unit.ids);
  refreshAbout(run, unit.ids);
}

/** Writes the unit's rows, its index and its ledger line in one transaction. */
export function writeUnit(
  run: ImportRun,
  unit: SourceUnit,
  plan: Writing,
): void {
  inTransaction(run.db, () => {
    if (plan.kind === 'insert') insertRows(run, unit);
    else replaceRows(run, unit);
    indexTranscripts(run, unit.ids);
    recordLedger(run, unit, plan.fingerprint);
  });
  (plan.kind === 'insert' ? run.report.inserted : run.report.updated).push(
    unit.rootId,
  );
}
