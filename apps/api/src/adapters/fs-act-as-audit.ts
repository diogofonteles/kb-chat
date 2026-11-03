import { open, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  actAsAuditEntrySchema,
  type ActAsAuditEntry,
} from '@kb-chat/contracts';
import type { ActAsAuditPort } from '../ports/act-as-audit.js';
import { isMissingFile } from './atomic-json.js';

const MONTH_FILE = /^act-as-(\d{4}-\d{2})\.jsonl$/;

const monthOf = (iso: string): string => iso.slice(0, 7);

/**
 * `<state>/audit/act-as-YYYY-MM.jsonl`, 0600, one JSON line per entry: opened in append
 * mode and synced to disk before `append` resolves, so a line is never lost to a crash
 * once the request answered (NFR-2). A bad line is skipped on read, never rewritten.
 */
export class FsActAsAudit implements ActAsAuditPort {
  constructor(
    private readonly dir: string,
    /** Opens the month's file; tests watch the append and the sync through it. */
    private readonly openFile: typeof open = open,
  ) {}

  async append(entry: ActAsAuditEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = await this.openFile(
      this.fileOf(monthOf(entry.at)),
      'a',
      0o600,
    );
    try {
      await file.appendFile(`${JSON.stringify(entry)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
  }

  async since(since: Date): Promise<ActAsAuditEntry[]> {
    const from = since.toISOString();
    const months = (await this.months()).filter((m) => m >= monthOf(from));
    const entries: ActAsAuditEntry[] = [];
    for (const month of months)
      entries.push(...entriesOf(await readFile(this.fileOf(month), 'utf8')));
    return entries.filter((entry) => entry.at >= from);
  }

  async prune(before: Date): Promise<number> {
    const limit = monthOf(before.toISOString());
    const old = (await this.months()).filter((month) => month < limit);
    await Promise.all(
      old.map((month) => rm(this.fileOf(month), { force: true })),
    );
    return old.length;
  }

  private async months(): Promise<string[]> {
    const names = await readdir(this.dir).catch((err: unknown) => {
      if (isMissingFile(err)) return [];
      throw err;
    });
    return names
      .map((name) => MONTH_FILE.exec(name)?.[1])
      .filter((month): month is string => month !== undefined)
      .sort();
  }

  private fileOf(month: string): string {
    return join(this.dir, `act-as-${month}.jsonl`);
  }
}

/** The valid lines of a month's file; a bad one is skipped, never rewritten. */
function entriesOf(text: string): ActAsAuditEntry[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => actAsAuditEntrySchema.safeParse(safeJson(line)))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
