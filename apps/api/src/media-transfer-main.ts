import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  exportPackage,
  importPackage,
  verifyProduction,
  type ImportReport,
  type VerifyReport,
} from './adapters/media-transfer/index.js';

/**
 * The media move from the owner's Mac to production (KBC-116, ADR 0038):
 *   export --out <dir>                   on the Mac (reads ~/.kb-chat-media and ~/.kb-chat only)
 *   import --package <dir> [--dry-run]   in a one-off container of the API image, API stopped
 *   verify                               production's media database and files, read only
 * Add --json for the report as JSON. Exit: 0 done with nothing held, 3 something held,
 * 1 failure, 2 wrong usage.
 */
const expandHome = (path: string): string =>
  path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;

const envSchema = z.object({
  KB_CHAT_MEDIA_DIR: z
    .string()
    .min(1)
    .default('~/.kb-chat-media')
    .transform(expandHome),
  KB_CHAT_STATE_DIR: z
    .string()
    .min(1)
    .default('~/.kb-chat')
    .transform(expandHome),
  KB_VAULT: z
    .string()
    .min(1)
    .default('~/dev/personal/hermetismo')
    .transform(expandHome),
  KB_CHAT_OWNER_EMAIL: z.email(),
});
type TransferEnv = z.infer<typeof envSchema>;

const USAGE =
  'usage: media-transfer-main export --out <dir> | import --package <dir> [--dry-run] | verify [--json]';

function lines(report: ImportReport): string[] {
  return [
    `package ${report.packageId}${report.dryRun ? ' (dry run: nothing changed)' : ''}`,
    `inserted ${report.inserted.length}, updated ${report.updated.length}, unchanged ${report.unchanged.length}, held ${report.held.length}`,
    ...report.held.map(
      (one) => `  held ${one.rootId} "${one.title}": ${one.reason}`,
    ),
    `files copied ${report.files.copied.length} (${report.files.bytes} bytes), already there ${report.files.present} (the list: --json)`,
    `people mapped ${report.people.mapped.length}, not in production ${report.people.unmapped.length} (${report.people.skippedRows} rows skipped), personal rows added ${report.people.rows}`,
    ...report.levels.unassigned.map(
      (one) =>
        `  no level for ${one.mediaId}: ${one.code ?? one.level} is not in production's scale`,
    ),
    `authors added ${report.authorsAdded.join(', ') || 'none'}; terms added ${report.termsAdded}; learning switches added ${report.switchesAdded}`,
  ];
}

function verifyLines(verify: VerifyReport): string[] {
  return [
    `check ${verify.ok ? 'ok' : 'FAILED'}: integrity ${verify.integrity}, broken keys ${verify.foreignKeys}, index ${verify.indexRows}/${verify.indexExpected}`,
    ...verify.ledgerMismatches.map((id) => `  changed since its import: ${id}`),
    ...verify.missingFiles.map((path) => `  missing file: ${path}`),
  ];
}

function print(value: unknown, text: string[], json: boolean): void {
  process.stdout.write(
    json ? `${JSON.stringify(value, null, 2)}\n` : `${text.join('\n')}\n`,
  );
}

async function runImport(
  env: TransferEnv,
  values: { package?: string; 'dry-run'?: boolean; json?: boolean },
): Promise<number> {
  if (!values.package) throw new UsageError();
  const report = await importPackage({
    packageDir: values.package,
    mediaDir: env.KB_CHAT_MEDIA_DIR,
    stateDir: env.KB_CHAT_STATE_DIR,
    vaultDir: env.KB_VAULT,
    ownerEmail: env.KB_CHAT_OWNER_EMAIL,
    dryRun: values['dry-run'] === true,
  });
  print(
    report,
    [...lines(report), ...(report.verify ? verifyLines(report.verify) : [])],
    values.json === true,
  );
  if (report.verify && !report.verify.ok) return 1;
  return report.held.length > 0 ? 3 : 0;
}

class UsageError extends Error {}

async function main(argv: readonly string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      package: { type: 'string' },
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });
  const env = envSchema.parse(process.env);
  const command = positionals[0];
  if (command === 'import') return runImport(env, values);
  if (command === 'verify') {
    const verify = verifyProduction(env.KB_CHAT_MEDIA_DIR);
    print(verify, verifyLines(verify), values.json === true);
    return verify.ok ? 0 : 1;
  }
  if (command !== 'export' || !values.out) throw new UsageError();
  return runExport(env, values.out);
}

async function runExport(env: TransferEnv, out: string): Promise<number> {
  const manifest = await exportPackage({
    mediaDir: env.KB_CHAT_MEDIA_DIR,
    stateDir: env.KB_CHAT_STATE_DIR,
    ownerEmail: env.KB_CHAT_OWNER_EMAIL,
    out: expandHome(out),
  });
  const bytes = Object.values(manifest.files).reduce(
    (sum, file) => sum + file.bytes,
    0,
  );
  process.stdout.write(
    `package ${manifest.packageId}: ${Object.keys(manifest.files).length} files, ${bytes} bytes, migration ${manifest.migrations.at(-1)?.[0] ?? 0}\n`,
  );
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const usage = err instanceof UsageError;
    process.stderr.write(
      `${usage ? USAGE : err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = usage ? 2 : 1;
  },
);
