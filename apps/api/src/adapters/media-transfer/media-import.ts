import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inTransaction, openMediaDatabase } from '../sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from '../sqlite/media-migrations.js';
import {
  emptyReport,
  type ImportReport,
  type ImportRun,
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
import { copyUnitFiles, writeUnit } from './unit-apply.js';
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

/** Both sides must run the same migrations (BR-9). */
function assertSameSchema(db: DatabaseSync): void {
  const there = JSON.stringify(appliedMigrations(db, 'main'));
  const here = JSON.stringify(appliedMigrations(db, 'src'));
  if (there === here) return;
  const last = (list: string): unknown =>
    (JSON.parse(list) as unknown[]).at(-1);
  throw new Error(
    `the package's media migrations differ from production's (package ${JSON.stringify(last(here))}, production ${JSON.stringify(last(there))}): export and import with the same release`,
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

async function importUnits(run: ImportRun): Promise<Set<string>> {
  const roots = new Set<string>();
  for (const unit of sourceUnits(run)) {
    const plan = await planUnit(run, unit);
    if (plan.kind === 'held') {
      run.report.held.push({
        rootId: unit.rootId,
        title: unit.title,
        reason: plan.reason,
      });
      continue;
    }
    if (plan.kind === 'unchanged') {
      run.report.unchanged.push(unit.rootId);
      continue;
    }
    await copyUnitFiles(run, plan);
    writeUnit(run, unit, plan);
    for (const media of unit.media)
      roots.add(rootOf(run.collections, media.topic));
  }
  return roots;
}

/** The authors the imported media name, appended to production's (BR-7). */
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
