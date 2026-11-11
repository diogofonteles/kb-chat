import { mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  levelAuditEntrySchema,
  type LevelAuditEntry,
} from '@kb-chat/contracts';
import {
  SCALE_AUDIT_KINDS,
  type LevelAuditPage,
  type LevelAuditPort,
  type LevelAuditRead,
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

/** A month parsed, and the file state it was parsed from. */
interface ParsedMonth<T> {
  readonly size: number;
  readonly mtimeMs: number;
  readonly value: T;
}

export interface FsLevelAuditOptions {
  /** How a month file is read (tests count the reads). */
  readonly readText?: (file: string) => Promise<string>;
}

/** Whole months kept parsed (the pages being read now); the rest is read again (R3-2). */
const WHOLE_MONTHS_KEPT = 2;
/** How long a line is kept: a month file goes once it is 12 months behind the newest. */
const MONTHS_KEPT = 12;

/** The month `months` before `month` (`YYYY-MM`). */
function monthsBefore(month: string, months: number): string {
  const [year = 0, mon = 1] = month.split('-').map(Number);
  const total = year * 12 + (mon - 1) - months;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/**
 * `<state>/audit/levels-YYYY-MM.jsonl`, 0600, one JSON line per change (ADR 0036 §11):
 * appended and synced before `append` resolves, so a change the API answered is never
 * missing from the audit. Every write starts on a fresh line (a torn last line never takes
 * the next one with it, R3-3), and a month file goes once it is 12 months behind (R3-2).
 */
export class FsLevelAudit implements LevelAuditPort {
  /** The scale's own lines of each month, parsed once until the file changes (R2-5). */
  private readonly scaleByMonth = new Map<
    string,
    ParsedMonth<readonly LevelAuditEntry[]>
  >();
  /** A few whole months, newest read last (R3-2: bounded). */
  private readonly whole = new Map<
    string,
    ParsedMonth<readonly LevelAuditEntry[]>
  >();
  private readonly readText: (file: string) => Promise<string>;
  /** The newest month pruned for, so a prune runs once a month. */
  private prunedFor: string | null = null;

  constructor(
    private readonly dir: string,
    options: FsLevelAuditOptions = {},
  ) {
    this.readText = options.readText ?? ((file) => readFile(file, 'utf8'));
  }

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
      await this.write(`levels-${month}.jsonl`, `\n${lines.join('\n')}\n`);
    await this.prune([...byMonth.keys()].sort().at(-1) ?? '');
  }

  /** "Histórico de níveis" (KBC-108 FR-4): the monthly files, newest first. */
  async read(query: LevelAuditRead): Promise<LevelAuditPage> {
    const months = await this.months();
    return pageOfAudit({ months, load: (month) => this.load(month) }, query);
  }

  /** Every month's scale lines, newest first (the history's codes and undone marks). */
  async scaleLines(): Promise<readonly LevelAuditEntry[]> {
    const months = (await this.months()).sort((a, b) => b.localeCompare(a));
    const lines: LevelAuditEntry[] = [];
    for (const month of months) {
      const kept = await this.parsedMonth(month, this.scaleByMonth, (all) =>
        all.filter((entry) => SCALE_AUDIT_KINDS.has(entry.kind)),
      );
      lines.push(...[...kept].reverse());
    }
    return lines;
  }

  /** How many whole months are kept parsed (tests). */
  monthsKeptWhole(): number {
    return this.whole.size;
  }

  private async months(): Promise<string[]> {
    return (await this.files()).flatMap((name) => {
      const month = MONTH_FILE.exec(name)?.[1];
      return month ? [month] : [];
    });
  }

  private async files(): Promise<string[]> {
    try {
      return await readdir(this.dir);
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
  }

  private async load(month: string): Promise<readonly LevelAuditEntry[]> {
    const lines = await this.parsedMonth(month, this.whole, (all) => all);
    // The month read last goes to the end; past the bound, the one read longest ago goes.
    const kept = this.whole.get(month);
    if (kept) {
      this.whole.delete(month);
      this.whole.set(month, kept);
    }
    for (const oldest of [...this.whole.keys()].slice(
      0,
      Math.max(0, this.whole.size - WHOLE_MONTHS_KEPT),
    ))
      this.whole.delete(oldest);
    return lines;
  }

  /** A month through `cache`, parsed again only once its file's size or mtime changed. */
  private async parsedMonth(
    month: string,
    cache: Map<string, ParsedMonth<readonly LevelAuditEntry[]>>,
    keep: (all: LevelAuditEntry[]) => readonly LevelAuditEntry[],
  ): Promise<readonly LevelAuditEntry[]> {
    const file = join(this.dir, `levels-${month}.jsonl`);
    const { size, mtimeMs } = await stat(file);
    const kept = cache.get(month);
    if (kept && kept.size === size && kept.mtimeMs === mtimeMs)
      return kept.value;
    const text = await this.readText(file);
    const value = keep(
      text.split('\n').flatMap((line) => parseLine(line) ?? []),
    );
    cache.set(month, { size, mtimeMs, value });
    return value;
  }

  /** Month files 12 months behind `newest` go, once per month (the port's 12 months). */
  private async prune(newest: string): Promise<void> {
    if (!newest || (this.prunedFor !== null && this.prunedFor >= newest))
      return;
    this.prunedFor = newest;
    const oldest = monthsBefore(newest, MONTHS_KEPT);
    for (const month of await this.months())
      if (month < oldest) {
        await rm(join(this.dir, `levels-${month}.jsonl`), { force: true });
        this.scaleByMonth.delete(month);
        this.whole.delete(month);
      }
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
