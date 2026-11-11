import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { unitFingerprint } from './fingerprint.js';
import type { VerifyReport } from './import-run.js';

/**
 * The check after an import (FR-9) and the rollout's "conferência": the database is sound,
 * every foreign key points somewhere, the search index has exactly the current transcripts,
 * every imported unit still has the rows the ledger recorded, and every file they name is on
 * disk (not looked at by a dry run, which copies nothing).
 */
function countOf(db: DatabaseSync, sql: string): number {
  return Number(db.prepare(sql).get()?.['n']);
}

function ledgerMismatches(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      'SELECT root_id, target_digest FROM main.media_imports ORDER BY root_id',
    )
    .all();
  return rows
    .filter((row) => {
      const ids = db
        .prepare(
          'SELECT id FROM main.media WHERE id = ? OR parent_media_id = ?',
        )
        .all(String(row['root_id']), String(row['root_id']))
        .map((one) => String(one['id']));
      return (
        unitFingerprint(db, { schema: 'main', ids }) !== row['target_digest']
      );
    })
    .map((row) => String(row['root_id']));
}

function missingFiles(db: DatabaseSync, mediaDir: string): string[] {
  return db
    .prepare(
      `SELECT path FROM main.media_files f JOIN main.media m ON m.id = f.media_id
         WHERE coalesce(m.parent_media_id, m.id) IN (SELECT root_id FROM main.media_imports)
       UNION SELECT raw_path FROM main.transcripts t JOIN main.media m ON m.id = t.media_id
         WHERE t.raw_path <> '' AND coalesce(m.parent_media_id, m.id) IN (SELECT root_id FROM main.media_imports)
       UNION SELECT raw_path FROM main.diarizations d JOIN main.media m ON m.id = d.media_id
         WHERE d.raw_path <> '' AND coalesce(m.parent_media_id, m.id) IN (SELECT root_id FROM main.media_imports)`,
    )
    .all()
    .map((row) => String(row['path']))
    .filter((path) => !existsSync(join(mediaDir, path)));
}

/** The search index's rows against the segments of the current transcripts. */
function indexCounts(db: DatabaseSync): {
  readonly indexRows: number;
  readonly indexExpected: number;
} {
  return {
    indexRows: countOf(db, 'SELECT count(*) AS n FROM main.segments_fts'),
    indexExpected: countOf(
      db,
      `SELECT count(*) AS n FROM main.segments s JOIN main.transcripts t ON t.id = s.transcript_id
       WHERE t.version = (SELECT max(version) FROM main.transcripts c WHERE c.media_id = t.media_id)`,
    ),
  };
}

export function verifyMedia(
  db: DatabaseSync,
  at: { readonly mediaDir: string; readonly checkFiles: boolean },
): VerifyReport {
  const integrity = String(
    db.prepare('PRAGMA main.integrity_check').get()?.['integrity_check'],
  );
  const foreignKeys = db.prepare('PRAGMA main.foreign_key_check').all().length;
  const { indexRows, indexExpected } = indexCounts(db);
  const mismatches = ledgerMismatches(db);
  const missing = at.checkFiles ? missingFiles(db, at.mediaDir) : [];
  return {
    integrity,
    foreignKeys,
    indexRows,
    indexExpected,
    ledgerMismatches: mismatches,
    missingFiles: missing,
    ok:
      integrity === 'ok' &&
      foreignKeys === 0 &&
      indexRows === indexExpected &&
      mismatches.length === 0 &&
      missing.length === 0,
  };
}
