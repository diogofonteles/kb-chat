import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  constants as fsConstants,
} from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { openMediaDatabase } from '../sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from '../sqlite/media-migrations.js';
import { isSafeMediaPath, STAYS_ON_THE_MAC } from './unit-tables.js';
import { levelCodesOf, principalsOf, readAuthors } from './state-files.js';

/**
 * The package the owner's Mac hands to production (ADR 0038 §1): a consistent copy of
 * `media.db` at the code's schema, the files its rows name, who each principal is, the
 * collections' authors and a manifest with every file's sha256. Building it only reads the
 * Mac's folders; voice prints and the revocation list are never read (ADR 0032).
 */
export const PACKAGE_FORMAT = 1;
const FILES = 'files';

const fileEntrySchema = z.strictObject({
  sha256: z.string().length(64),
  bytes: z.number(),
});
const manifestSchema = z.strictObject({
  format: z.literal(PACKAGE_FORMAT),
  packageId: z.string().min(1),
  createdAt: z.string(),
  migrations: z.array(z.tuple([z.number(), z.string()])),
  parts: z.strictObject({
    'media.db': fileEntrySchema,
    'principals.json': fileEntrySchema,
    'authors.json': fileEntrySchema,
    'levels.json': fileEntrySchema,
  }),
  files: z.record(z.string(), fileEntrySchema),
});
export type Manifest = z.infer<typeof manifestSchema>;
const principalsSchema = z.array(
  z.strictObject({ principal: z.string(), email: z.string() }),
);
const levelCodesSchema = z.record(z.string(), z.string());

export interface ExportOptions {
  readonly mediaDir: string;
  readonly stateDir: string;
  readonly ownerEmail: string;
  readonly out: string;
}

export async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const entryOf = async (
  path: string,
): Promise<z.infer<typeof fileEntrySchema>> => ({
  sha256: await sha256Of(path),
  bytes: (await stat(path)).size,
});

/**
 * Empties, in the copy, what never leaves the Mac (QA F-1): voice consents and profiles,
 * paired transcribers (token hashes), spend, settings, provider caches, the publication and
 * sync queues; voice-profile jobs go with their profiles, and the leases of the jobs still
 * under way (they travel only to hold their unit, BR-1). VACUUM then rewrites the file, so no
 * freed page keeps a deleted row.
 */
function stripWhatStays(copy: DatabaseSync): void {
  for (const table of STAYS_ON_THE_MAC) copy.exec(`DELETE FROM ${table}`);
  copy.exec(`DELETE FROM jobs WHERE kind = 'voice-profile'`);
  copy.exec(
    'UPDATE jobs SET lease_id = NULL, lease_until = NULL, heartbeat_at = NULL',
  );
  copy.exec('VACUUM');
}

/** A snapshot from a read-only connection (WAL-safe), migrated in the copy, never in place. */
function snapshotDatabase(
  mediaDir: string,
  target: string,
): [number, string][] {
  const live = new DatabaseSync(join(mediaDir, 'media.db'), { readOnly: true });
  try {
    live.prepare('VACUUM INTO ?').run(target);
  } finally {
    live.close();
  }
  const copy = openMediaDatabase(target, MEDIA_MIGRATIONS);
  try {
    copy.exec('PRAGMA journal_mode = DELETE');
    stripWhatStays(copy);
    return appliedMigrations(copy);
  } finally {
    copy.close();
  }
}

export function appliedMigrations(
  db: DatabaseSync,
  schema = 'main',
): [number, string][] {
  return db
    .prepare(
      `SELECT version, name FROM ${schema}.schema_migrations ORDER BY version`,
    )
    .all()
    .map((row) => [Number(row['version']), String(row['name'])]);
}

/** Every file the package's rows name. */
function referencedFiles(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT path FROM media_files UNION SELECT raw_path FROM transcripts WHERE raw_path <> ''
         UNION SELECT raw_path FROM diarizations WHERE raw_path <> ''
         UNION SELECT path FROM media_track_old_files
         UNION SELECT cut_path FROM media_tracks WHERE cut_path IS NOT NULL ORDER BY 1`,
      )
      .all()
      .map((row) => String(row['path']));
  } finally {
    db.close();
  }
}

/** Copies one file into the package unless the same bytes are already there (a re-export). */
async function packFile(
  options: ExportOptions,
  path: string,
): Promise<z.infer<typeof fileEntrySchema> | null> {
  const from = join(options.mediaDir, path);
  if (!isSafeMediaPath(path) || !existsSync(from)) return null;
  const to = join(options.out, FILES, path);
  const source = await entryOf(from);
  if (existsSync(to) && (await sha256Of(to)) === source.sha256) return source;
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to, fsConstants.COPYFILE_FICLONE);
  return source;
}

/** Removes package files no row names any more (left by an earlier export). */
async function pruneFiles(
  out: string,
  kept: ReadonlySet<string>,
): Promise<void> {
  const root = join(out, FILES);
  if (!existsSync(root)) return;
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((one) => one.isFile())) {
    const path = relative(root, join(entry.parentPath, entry.name));
    if (!kept.has(path)) await rm(join(root, path));
  }
}

async function packFiles(
  options: ExportOptions,
  dbPath: string,
): Promise<Manifest['files']> {
  const files: Manifest['files'] = {};
  for (const path of referencedFiles(dbPath)) {
    const entry = await packFile(options, path);
    if (entry) files[path] = entry;
  }
  await pruneFiles(options.out, new Set(Object.keys(files)));
  return files;
}

async function writeParts(options: ExportOptions): Promise<void> {
  const write = (name: string, value: unknown): Promise<void> =>
    writeFile(join(options.out, name), `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
  await write(
    'principals.json',
    principalsOf(options.stateDir, options.ownerEmail),
  );
  await write(
    'authors.json',
    readAuthors(join(options.stateDir, 'authors.json')),
  );
  await write('levels.json', levelCodesOf(options.stateDir));
}

/** `sha256sum -c` lines for every part and file, so the VM checks the copy before importing. */
async function writeChecksums(out: string, manifest: Manifest): Promise<void> {
  const lines = [
    `${await sha256Of(join(out, 'manifest.json'))}  manifest.json`,
    ...Object.entries(manifest.parts).map(
      ([name, entry]) => `${entry.sha256}  ${name}`,
    ),
    ...Object.entries(manifest.files).map(
      ([path, entry]) => `${entry.sha256}  ${FILES}/${path}`,
    ),
  ];
  await writeFile(join(out, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

/** Builds (or refreshes) the package in `out`; returns its manifest. */
export async function exportPackage(options: ExportOptions): Promise<Manifest> {
  await mkdir(options.out, { recursive: true, mode: 0o700 });
  const dbPath = join(options.out, 'media.db');
  await rm(dbPath, { force: true });
  const migrations = snapshotDatabase(options.mediaDir, dbPath);
  const files = await packFiles(options, dbPath);
  await writeParts(options);
  const part = (name: string) => entryOf(join(options.out, name));
  const parts: Manifest['parts'] = {
    'media.db': await part('media.db'),
    'principals.json': await part('principals.json'),
    'authors.json': await part('authors.json'),
    'levels.json': await part('levels.json'),
  };
  const manifest: Manifest = {
    format: PACKAGE_FORMAT,
    packageId: randomUUID(),
    createdAt: new Date().toISOString(),
    migrations,
    parts,
    files,
  };
  await writeFile(
    join(options.out, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeChecksums(options.out, manifest);
  return manifest;
}

export interface OpenedPackage {
  readonly dir: string;
  readonly manifest: Manifest;
  readonly principals: z.infer<typeof principalsSchema>;
  readonly levelCodes: Readonly<Record<string, string>>;
  /** Path of a package file, by its media-relative path. */
  fileOf(path: string): string;
}

/** Each part and file against the manifest: the first difference refuses the whole run (FR-2). */
async function verifyEntries(dir: string, manifest: Manifest): Promise<void> {
  const entries: [string, z.infer<typeof fileEntrySchema>][] = [
    ...Object.entries(manifest.parts),
    ...Object.entries(manifest.files).map(
      ([path, entry]): [string, typeof entry] => {
        if (!isSafeMediaPath(path))
          throw new Error(`the package names an unsafe path: ${path}`);
        return [join(FILES, path), entry];
      },
    ),
  ];
  for (const [name, entry] of entries) {
    const path = join(dir, name);
    if (!existsSync(path) || (await sha256Of(path)) !== entry.sha256)
      throw new Error(`the package's ${name} does not match its manifest`);
  }
}

const readPart = async (dir: string, name: string): Promise<unknown> =>
  JSON.parse(await readFile(join(dir, name), 'utf8'));

/** Reads and verifies a package; throws before anything changes when it does not match. */
export async function openPackage(dir: string): Promise<OpenedPackage> {
  const manifest = manifestSchema.parse(await readPart(dir, 'manifest.json'));
  await verifyEntries(dir, manifest);
  return {
    dir,
    manifest,
    principals: principalsSchema.parse(await readPart(dir, 'principals.json')),
    levelCodes: levelCodesSchema.parse(await readPart(dir, 'levels.json')),
    fileOf: (path) => join(dir, FILES, path),
  };
}
