import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inTransaction, openMediaDatabase } from '../sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from '../sqlite/media-migrations.js';
import {
  emptyReport,
  ImportFailure,
  type ImportReport,
  type ImportRun,
  type SourceUnit,
} from './import-run.js';
import {
  appliedMigrations,
  openPackage,
  type OpenedPackage,
} from './media-package.js';
import {
  copyLearningSwitches,
  copyPersonalRows,
  createMaps,
  mergeTerms,
} from './shared-rows.js';
import {
  collectionsOf,
  mergeAuthors,
  principalsOf,
  readAuthors,
  rootOf,
  scalesOf,
  writeAuthors,
} from './state-files.js';
import { removeStaleCopies } from './temp-files.js';
import { copyUnitFiles, recordLedger, writeUnit } from './unit-apply.js';
import { planUnit, sourceUnits } from './unit-plan.js';
import { verifyMedia } from './verify.js';

export interface ImportOptions {
  readonly packageDir: string;
  readonly mediaDir: string;
  readonly stateDir: string;
  readonly vaultDir: string;
  readonly ownerEmail: string;
  readonly dryRun: boolean;
  readonly now?: Date;
}

/** A dry run works on a snapshot of production's database and copies no file (FR-8). */
function targetPath(options: ImportOptions, work: string): string {
  const live = join(options.mediaDir, 'media.db');
  if (!options.dryRun) return live;
  const copy = join(work, 'target.db');
  if (!existsSync(live)) return copy;
  const db = new DatabaseSync(live, { readOnly: true });
  try {
    db.prepare('VACUUM INTO ?').run(copy);
  } finally {
    db.close();
  }
  return copy;
}

function refuseDifferent(
  here: readonly unknown[],
  there: readonly unknown[],
  side: string,
): void {
  if (JSON.stringify(here) === JSON.stringify(there)) return;
  throw new Error(
    `the package's media migrations differ from ${side} (package ${JSON.stringify(here.at(-1))}, ${side} ${JSON.stringify(there.at(-1))}): export and import with the same release`,
  );
}

/**
 * Both sides must run the same migrations (BR-9), looked at before production's database is
 * opened, since opening it with this code would run the migrations it lacks (review nit).
 */
function refuseOtherSchema(pkg: OpenedPackage, options: ImportOptions): void {
  const code = MEDIA_MIGRATIONS.map((one) => [one.version, one.name]);
  refuseDifferent(pkg.manifest.migrations, code, "this release's");
  const live = join(options.mediaDir, 'media.db');
  if (!existsSync(live)) return;
  const db = new DatabaseSync(live, { readOnly: true });
  try {
    refuseDifferent(
      pkg.manifest.migrations,
      appliedMigrations(db),
      'production',
    );
  } finally {
    db.close();
  }
}

/** The same check on the attached copies, the ones the import reads. */
function assertSameSchema(db: DatabaseSync): void {
  refuseDifferent(
    appliedMigrations(db, 'src'),
    appliedMigrations(db, 'main'),
    'production',
  );
}

/** Package principal → production principal, by e-mail (BR-5). */
function mapPeople(run: ImportRun, options: ImportOptions): void {
  const there = new Map(
    principalsOf(options.stateDir, options.ownerEmail).map((one) => [
      one.email,
      one.principal,
    ]),
  );
  const insert = run.db.prepare(
    'INSERT OR REPLACE INTO temp.principal_map (src, dst) VALUES (?, ?)',
  );
  for (const person of run.pkg.principals) {
    const principal = there.get(person.email.toLowerCase());
    if (principal) insert.run(person.principal, principal);
    (principal ? run.report.people.mapped : run.report.people.unmapped).push(
      person.email,
    );
  }
}

function startRun(
  db: DatabaseSync,
  pkg: OpenedPackage,
  options: ImportOptions,
): ImportRun {
  createMaps(db);
  db.exec('CREATE TEMP TABLE open_media (id TEXT PRIMARY KEY)');
  const run: ImportRun = {
    db,
    pkg,
    mediaDir: options.mediaDir,
    collections: collectionsOf(options.stateDir, options.vaultDir),
    scales: scalesOf(options.stateDir),
    dryRun: options.dryRun,
    now: options.now ?? new Date(),
    report: emptyReport(pkg.manifest.packageId, options.dryRun),
  };
  mapPeople(run, options);
  return run;
}

/** A unit production has as the Mac does after this run: its people's rows may go (BR-3). */
function openUnit(run: ImportRun, unit: SourceUnit, roots: Set<string>): void {
  const insert = run.db.prepare(
    'INSERT OR IGNORE INTO temp.open_media (id) VALUES (?)',
  );
  for (const media of unit.media) {
    insert.run(media.id);
    roots.add(rootOf(run.collections, media.topic));
  }
}

async function importUnit(
  run: ImportRun,
  unit: SourceUnit,
  roots: Set<string>,
): Promise<void> {
  const plan = await planUnit(run, unit);
  if (plan.kind === 'held') {
    run.report.held.push({
      rootId: unit.rootId,
      title: unit.title,
      reason: plan.reason,
    });
    return;
  }
  if (plan.kind === 'unchanged') {
    const again = plan.rebaseline;
    if (again)
      inTransaction(run.db, () => recordLedger(run, unit, again.fingerprint));
    run.report.unchanged.push(unit.rootId);
  } else {
    await copyUnitFiles(run, plan);
    writeUnit(run, unit, plan);
  }
  openUnit(run, unit, roots);
}

/**
 * Every unit in turn. A unit that fails stops the run with its name and the report of what
 * the run did before it (QA F-4); the units already written stay whole.
 */
async function importUnits(run: ImportRun): Promise<Set<string>> {
  const roots = new Set<string>();
  for (const unit of sourceUnits(run)) {
    try {
      await importUnit(run, unit, roots);
    } catch (err) {
      throw new ImportFailure(
        `unit ${unit.rootId} "${unit.title}" failed, nothing of it changed: ${err instanceof Error ? err.message : String(err)}`,
        run.report,
        { cause: err },
      );
    }
  }
  return roots;
}

/**
 * The authors of every collection production now has units of, appended to production's
 * (BR-7): the unchanged ones too, so the authors of units an earlier run wrote before it
 * failed still arrive; appending is idempotent.
 */
async function mergeAuthorFiles(
  run: ImportRun,
  options: ImportOptions,
  roots: Set<string>,
): Promise<void> {
  const path = join(options.stateDir, 'authors.json');
  const merged = mergeAuthors(
    readAuthors(path),
    readAuthors(join(options.packageDir, 'authors.json')),
    roots,
  );
  run.report.authorsAdded = merged.added;
  if (merged.added.length > 0 && !options.dryRun)
    await writeAuthors(path, merged.next);
}

async function runImport(
  db: DatabaseSync,
  pkg: OpenedPackage,
  options: ImportOptions,
): Promise<ImportReport> {
  const run = startRun(db, pkg, options);
  const roots = await importUnits(run);
  inTransaction(db, () => {
    mergeTerms(run);
    copyLearningSwitches(run);
    copyPersonalRows(run);
  });
  await mergeAuthorFiles(run, options, roots);
  run.report.verify = verifyMedia(db, {
    mediaDir: options.mediaDir,
    checkFiles: !options.dryRun,
  });
  return run.report;
}

/**
 * Imports a package into production (ADR 0038): verified first, then unit by unit, each in
 * its own transaction; a unit that cannot go is held and listed, never half written.
 */
export async function importPackage(
  options: ImportOptions,
): Promise<ImportReport> {
  const pkg = await openPackage(options.packageDir);
  refuseOtherSchema(pkg, options);
  if (!options.dryRun) removeStaleCopies(options.mediaDir);
  const work = await mkdtemp(join(tmpdir(), 'kb-chat-media-import-'));
  try {
    const source = join(work, 'source.db');
    await copyFile(join(options.packageDir, 'media.db'), source);
    const db = openMediaDatabase(targetPath(options, work), MEDIA_MIGRATIONS);
    try {
      db.prepare('ATTACH DATABASE ? AS src').run(source);
      assertSameSchema(db);
      return await runImport(db, pkg, options);
    } finally {
      db.close();
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The standalone check of production's media (the rollout's last step). */
export function verifyProduction(
  mediaDir: string,
): ReturnType<typeof verifyMedia> {
  const db = new DatabaseSync(join(mediaDir, 'media.db'), { readOnly: true });
  try {
    return verifyMedia(db, { mediaDir, checkFiles: true });
  } finally {
    db.close();
  }
}
