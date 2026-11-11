import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  levelAuditEntrySchema,
  type LevelAuditEntry,
} from '@kb-chat/contracts';
import type {
  LevelAuditPage,
  LevelAuditPort,
  LevelAuditRead,
} from '../ports/level-audit.js';
import { pageOfAudit } from './level-audit-page.js';

const MONTH_FILE = /^levels-(\d{4}-\d{2})\.jsonl$/;

/** A line that does not parse (a torn write, a hand edit) is left out of the history. */
function parseLine(line: string): LevelAuditEntry | null {
  if (line.trim() === '') return null;
  try {
    const parsed = levelAuditEntrySchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const isMissing = (err: unknown): boolean =>
  err instanceof Error && 'code' in err && err.code === 'ENOENT';

/**
 * `<state>/audit/levels-YYYY-MM.jsonl`, 0600, one JSON line per change (ADR 0036 §11):
 * appended and synced before `append` resolves, so a change the API answered is never
 * missing from the audit.
 */
export class FsLevelAudit implements LevelAuditPort {
  constructor(private readonly dir: string) {}

  append(entry: LevelAuditEntry): Promise<void> {
    return this.appendMany([entry]);
  }

  async appendMany(entries: readonly LevelAuditEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const byMonth = new Map<string, string[]>();
    for (const entry of entries) {
      const month = entry.at.slice(0, 7);
      byMonth.set(month, [
        ...(byMonth.get(month) ?? []),
        JSON.stringify(entry),
      ]);
    }
    for (const [month, lines] of byMonth)
      await this.write(`levels-${month}.jsonl`, `${lines.join('\n')}\n`);
  }

  /** "Histórico de níveis" (KBC-108 FR-4): the monthly files, newest first. */
  async read(query: LevelAuditRead): Promise<LevelAuditPage> {
    const months = (await this.files()).flatMap((name) => {
      const month = MONTH_FILE.exec(name)?.[1];
      return month ? [month] : [];
    });
    return pageOfAudit({ months, load: (month) => this.load(month) }, query);
  }

  private async files(): Promise<string[]> {
    try {
      return await readdir(this.dir);
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
  }

  private async load(month: string): Promise<LevelAuditEntry[]> {
    const text = await readFile(
      join(this.dir, `levels-${month}.jsonl`),
      'utf8',
    );
    return text.split('\n').flatMap((line) => parseLine(line) ?? []);
  }

  private async write(name: string, text: string): Promise<void> {
    const file = await open(join(this.dir, name), 'a', 0o600);
    try {
      await file.appendFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
  }
}
