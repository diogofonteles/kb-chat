import type { LevelAuditEntry } from '@kb-chat/contracts';
import type {
  LevelAuditPage,
  LevelAuditPosition,
  LevelAuditRead,
} from '../ports/level-audit.js';

/** The audit's months and how to read one (a file, or the lines kept in memory). */
export interface AuditMonths {
  readonly months: readonly string[];
  readonly load: (month: string) => Promise<readonly LevelAuditEntry[]>;
}

/** The months a read covers, newest first, from where the last page stopped. */
function monthsToRead(months: readonly string[], query: LevelAuditRead) {
  const { fromMonth, toMonth, after } = query;
  return [...months]
    .sort((a, b) => b.localeCompare(a))
    .filter((month) => !fromMonth || month >= fromMonth)
    .filter((month) => !toMonth || month <= toMonth)
    .filter((month) => !after || month <= after.month);
}

/** The matches of one month, from its end (or from where the cursor stopped). */
function scanMonth(
  lines: readonly LevelAuditEntry[],
  scan: {
    readonly query: LevelAuditRead;
    readonly start: number;
    readonly found: LevelAuditEntry[];
  },
): number | null {
  const { query, start, found } = scan;
  for (let index = start - 1; index >= 0; index -= 1) {
    const entry = lines[index];
    if (!entry || !query.accepts(entry)) continue;
    if (found.length === query.limit) return index + 1;
    found.push(entry);
  }
  return null;
}

/**
 * One page of the audit, newest first (KBC-108 FR-4): months from the newest, each month's
 * lines from its end; a month is read only when the page still needs lines.
 */
export async function pageOfAudit(
  source: AuditMonths,
  query: LevelAuditRead,
): Promise<LevelAuditPage> {
  const found: LevelAuditEntry[] = [];
  for (const month of monthsToRead(source.months, query)) {
    const lines = await source.load(month);
    const start =
      query.after?.month === month ? query.after.index : lines.length;
    const stop = scanMonth(lines, { query, start, found });
    if (stop !== null) {
      const next: LevelAuditPosition = { month, index: stop };
      return { entries: found, next };
    }
  }
  return { entries: found, next: null };
}
