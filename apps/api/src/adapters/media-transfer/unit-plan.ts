import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { unitFingerprint } from './fingerprint.js';
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
  | { readonly kind: 'unchanged' }
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
}

function ledgerOf(run: ImportRun, rootId: string): Ledger | null {
  const row = run.db
    .prepare(
      'SELECT source_digest, target_digest FROM main.media_imports WHERE root_id = ?',
    )
    .get(rootId);
  return row
    ? {
        source: String(row['source_digest']),
        target: String(row['target_digest']),
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

/** What changed since the ledger's import, on either side. */
function planAgainstLedger(
  run: ImportRun,
  unit: SourceUnit,
  at: { ledger: Ledger; fingerprint: string; files: string[] },
): UnitPlan {
  if (at.fingerprint === at.ledger.source) return { kind: 'unchanged' };
  const there = targetIds(run, unit.rootId);
  if (
    unitFingerprint(run.db, { schema: 'main', ids: there }) !== at.ledger.target
  )
    return held('mudou na produção desde a última importação');
  const ids = new Set(unit.media.map((one) => one.id));
  if (there.some((id) => !ids.has(id)))
    return held('faixa removida no Mac (nada é apagado na produção)');
  const added = unit.media.filter((one) => !there.includes(one.id));
  const scale = scaleMissing(run, added);
  if (scale) return held(`escala ausente na produção: ${scale}`);
  return { kind: 'replace', fingerprint: at.fingerprint, files: at.files };
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
  const fingerprint = unitFingerprint(
    run.db,
    { schema: 'src', ids: unit.media.map((one) => one.id) },
    files.hashes,
  );
  const ledger = ledgerOf(run, unit.rootId);
  const paths = files.hashes.map((one) => one.slice(0, one.lastIndexOf(':')));
  if (ledger)
    return planAgainstLedger(run, unit, { ledger, fingerprint, files: paths });
  if (targetIds(run, unit.rootId).length > 0)
    return held('já existe na produção sem registro de importação');
  const scale = scaleMissing(run, unit.media);
  if (scale) return held(`escala ausente na produção: ${scale}`);
  return { kind: 'insert', fingerprint, files: paths };
}
