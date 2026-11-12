import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  digestColumns,
  digestColumnsText,
  missingDigestColumns,
  parseDigestColumns,
  unitFingerprint,
  type DigestColumns,
} from './fingerprint.js';
import type { ImportRun, SourceMedia, SourceUnit } from './import-run.js';
import { sha256Of } from './media-package.js';
import { hasCollection, rootOf } from './state-files.js';
import { isSafeMediaPath, unitFilesQuery } from './unit-tables.js';

/** What a run does with one unit (ADR 0038 §3). */
export type UnitPlan =
  | {
      readonly kind: 'insert' | 'replace';
      readonly fingerprint: string;
      readonly files: readonly string[];
    }
  | {
      readonly kind: 'unchanged';
      /** The ledger line was made on an older set of columns: redo it on today's (review M2). */
      readonly rebaseline?: { readonly fingerprint: string };
    }
  | { readonly kind: 'held'; readonly reason: string };

const held = (reason: string): UnitPlan => ({ kind: 'held', reason });

/** The package's recordings, each with its tracks. */
export function sourceUnits(run: ImportRun): SourceUnit[] {
  const rows = run.db
    .prepare(
      `SELECT id, topic, title, level, coalesce(parent_media_id, id) AS root
       FROM src.media ORDER BY root, parent_media_id IS NOT NULL, coalesce(track_ordinal, 0), id`,
    )
    .all();
  const units = new Map<string, { title: string; media: SourceMedia[] }>();
  for (const row of rows) {
    const root = String(row['root']);
    const unit = units.get(root) ?? { title: String(row['title']), media: [] };
    unit.media.push({
      id: String(row['id']),
      topic: String(row['topic']),
      level: row['level'] === null ? null : String(row['level']),
    });
    units.set(root, unit);
  }
  return [...units].map(([rootId, unit]) => ({
    rootId,
    ...unit,
    ids: JSON.stringify(unit.media.map((one) => one.id)),
  }));
}

/** Work still under way on the Mac: it goes in a later run (BR-1). */
function inProgress(run: ImportRun, unit: SourceUnit): boolean {
  const row = run.db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM src.media WHERE id IN (SELECT value FROM json_each(:ids))
                AND status <> 'ready')
         OR EXISTS (SELECT 1 FROM src.jobs WHERE media_id IN (SELECT value FROM json_each(:ids))
                AND status IN ('queued', 'leased'))
         OR EXISTS (SELECT 1 FROM src.media_tracks WHERE media_id IN (SELECT value FROM json_each(:ids))
                AND cut_status = 'pending') AS busy`,
    )
    .get({ ids: unit.ids });
  return Number(row?.['busy']) === 1;
}

function missingCollection(run: ImportRun, unit: SourceUnit): string | null {
  const topic = unit.media.find(
    (one) => !hasCollection(run.collections, one.topic),
  )?.topic;
  return topic ?? null;
}

/** A level production cannot hold without opening it: a level where it has no scale (BR-6). */
function scaleMissing(
  run: ImportRun,
  media: readonly SourceMedia[],
): string | null {
  const one = media.find(
    (item) =>
      item.level !== null &&
      !run.scales.has(rootOf(run.collections, item.topic)),
  );
  return one ? rootOf(run.collections, one.topic) : null;
}

/** The unit's files with their package hashes, or why they cannot go (BR-8). */
async function checkFiles(
  run: ImportRun,
  unit: SourceUnit,
): Promise<{ readonly hashes: string[]; readonly reason: string | null }> {
  const paths = run.db
    .prepare(unitFilesQuery('src'))
    .all({ ids: unit.ids })
    .map((row) => String(row['path']));
  const hashes: string[] = [];
  for (const path of paths) {
    const entry = run.pkg.manifest.files[path];
    if (!entry || !isSafeMediaPath(path))
      return { hashes, reason: `arquivo ausente no pacote: ${path}` };
    hashes.push(`${path}:${entry.sha256}`);
    const there = join(run.mediaDir, path);
    if (existsSync(there) && (await sha256Of(there)) !== entry.sha256)
      return { hashes, reason: `arquivo diferente na produção: ${path}` };
  }
  return { hashes, reason: null };
}

interface Ledger {
  readonly source: string;
  readonly target: string;
  readonly columns: DigestColumns;
}

function ledgerOf(run: ImportRun, rootId: string): Ledger | null {
  const row = run.db
    .prepare(
      'SELECT source_digest, target_digest, digest_columns FROM main.media_imports WHERE root_id = ?',
    )
    .get(rootId);
  return row
    ? {
        source: String(row['source_digest']),
        target: String(row['target_digest']),
        columns: parseDigestColumns(String(row['digest_columns'])),
      }
    : null;
}

/** Production's media of the unit: the recording and every track it has there. */
export function targetIds(run: ImportRun, rootId: string): string[] {
  return run.db
    .prepare(
      'SELECT id FROM main.media WHERE id = ? OR parent_media_id = ? ORDER BY id',
    )
    .all(rootId, rootId)
    .map((row) => String(row['id']));
}

interface LedgerCheck {
  readonly ledger: Ledger;
  readonly fingerprint: string;
  readonly fileHashes: readonly string[];
  readonly files: readonly string[];
}

/** Columns of a ledger line's set that either side no longer has. */
function goneColumns(run: ImportRun, columns: DigestColumns): string[] {
  return [
    ...missingDigestColumns(run.db, 'src', columns),
    ...missingDigestColumns(run.db, 'main', columns),
  ];
}

/**
 * The digests to set against the ledger line, on the line's own columns (review M2): the
 * source's and production's now, or why they cannot be redone (a column a migration dropped).
 */
function digestsNow(
  run: ImportRun,
  unit: SourceUnit,
  at: LedgerCheck & { readonly there: readonly string[] },
):
  | { readonly same: boolean; readonly source: string; readonly target: string }
  | { readonly gone: string } {
  const { columns } = at.ledger;
  const same =
    digestColumnsText(columns) ===
    digestColumnsText(digestColumns(run.db, 'main'));
  const gone = same ? [] : goneColumns(run, columns);
  if (gone.length > 0) return { gone: [...new Set(gone)].join(', ') };
  const ids = unit.media.map((one) => one.id);
  const source = same
    ? at.fingerprint
    : unitFingerprint(run.db, {
        schema: 'src',
        ids,
        fileHashes: at.fileHashes,
        columns,
      });
  const target = unitFingerprint(run.db, {
    schema: 'main',
    ids: at.there,
    columns,
  });
  return { same, source, target };
}

/** What changed since the ledger's import, on either side. */
function planAgainstLedger(
  run: ImportRun,
  unit: SourceUnit,
  at: LedgerCheck,
): UnitPlan {
  const there = targetIds(run, unit.rootId);
  const now = digestsNow(run, unit, { ...at, there });
  if ('gone' in now)
    return held(
      `a última importação usou colunas que não existem mais: ${now.gone}`,
    );
  const productionSame = now.target === at.ledger.target;
  if (now.source === at.ledger.source)
    return now.same || !productionSame
      ? { kind: 'unchanged' }
      : { kind: 'unchanged', rebaseline: { fingerprint: at.fingerprint } };
  if (!productionSame)
    return held('mudou na produção desde a última importação');
  const ids = new Set(unit.media.map((one) => one.id));
  if (there.some((id) => !ids.has(id)))
    return held('faixa removida no Mac (nada é apagado na produção)');
  const added = unit.media.filter((one) => !there.includes(one.id));
  const scale = scaleMissing(run, added);
  if (scale) return held(`escala ausente na produção: ${scale}`);
  return { kind: 'replace', fingerprint: at.fingerprint, files: at.files };
}

/** A unit production has no ledger line for: new, or already there by other means. */
function planFirstImport(
  run: ImportRun,
  unit: SourceUnit,
  at: { readonly fingerprint: string; readonly files: readonly string[] },
): UnitPlan {
  if (targetIds(run, unit.rootId).length > 0)
    return held('já existe na produção sem registro de importação');
  const scale = scaleMissing(run, unit.media);
  if (scale) return held(`escala ausente na produção: ${scale}`);
  return { kind: 'insert', fingerprint: at.fingerprint, files: at.files };
}

/** Decides what to do with one unit; changes nothing. */
export async function planUnit(
  run: ImportRun,
  unit: SourceUnit,
): Promise<UnitPlan> {
  if (inProgress(run, unit))
    return held('em andamento no Mac (vai na próxima execução)');
  const collection = missingCollection(run, unit);
  if (collection)
    return held(
      `acervo ausente na produção: ${collection} (rode o sync do vault)`,
    );
  const files = await checkFiles(run, unit);
  if (files.reason) return held(files.reason);
  const fingerprint = unitFingerprint(run.db, {
    schema: 'src',
    ids: unit.media.map((one) => one.id),
    fileHashes: files.hashes,
  });
  const paths = files.hashes.map((one) => one.slice(0, one.lastIndexOf(':')));
  const ledger = ledgerOf(run, unit.rootId);
  return ledger
    ? planAgainstLedger(run, unit, {
        ledger,
        fingerprint,
        fileHashes: files.hashes,
        files: paths,
      })
    : planFirstImport(run, unit, { fingerprint, files: paths });
}
