import type { UsageRecord } from '@kb-chat/contracts';
import type { SpendEntry } from '../../ports/spend-ledger.js';

/** One row of the usage report (KBC-006 BR-4). */
export interface WeekUsage {
  /** Monday of the ISO week, YYYY-MM-DD (UTC). */
  readonly week: string;
  readonly sessions: number;
  readonly searches: number;
  /** Share of searches followed by an opened document before the next search (0–1). */
  readonly searchesWithOpenDoc: number;
  /** Share of searches followed by an AI answer (or a stopped one) before the next search. */
  readonly searchesWithAi: number;
  /** Share of sessions that used a filter. */
  readonly sessionsWithFilter: number;
  readonly spendUsd: number;
}

const DAY_MS = 86_400_000;

/** Monday of the ISO week of a timestamp, in UTC. */
export function weekOf(ts: string): string {
  const date = new Date(ts);
  const day = (date.getUTCDay() + 6) % 7;
  const monday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) -
      day * DAY_MS,
  );
  return monday.toISOString().slice(0, 10);
}

interface SearchOutcome {
  opened: boolean;
  ai: boolean;
}

interface WeekAccumulator {
  sessions: Set<string>;
  filteredSessions: Set<string>;
  searches: SearchOutcome[];
  spendUsd: number;
}

const share = (part: number, whole: number): number =>
  whole === 0 ? 0 : part / whole;

function accumulate(records: readonly UsageRecord[]) {
  const weeks = new Map<string, WeekAccumulator>();
  const week = (key: string): WeekAccumulator => {
    let acc = weeks.get(key);
    if (!acc) {
      acc = {
        sessions: new Set(),
        filteredSessions: new Set(),
        searches: [],
        spendUsd: 0,
      };
      weeks.set(key, acc);
    }
    return acc;
  };
  // The latest search of each session receives the documents opened and answers asked after it.
  const lastSearch = new Map<string, SearchOutcome>();
  const sorted = [...records].sort(
    (a, b) => Date.parse(a.ts) - Date.parse(b.ts),
  );
  for (const record of sorted) {
    const acc = week(weekOf(record.ts));
    acc.sessions.add(record.sessionId);
    const filtered =
      record.type === 'filter' ||
      (record.type === 'search' && record.filterCount > 0);
    if (filtered) acc.filteredSessions.add(record.sessionId);
    if (record.type === 'search') {
      const outcome = { opened: false, ai: false };
      acc.searches.push(outcome);
      lastSearch.set(record.sessionId, outcome);
    }
    const current = lastSearch.get(record.sessionId);
    if (current && record.type === 'open_doc') current.opened = true;
    if (current && (record.type === 'ai_answer' || record.type === 'ai_cancel'))
      current.ai = true;
  }
  return { weeks, week };
}

/** Weekly metrics of the brief from the local usage log and the spend ledger. */
export function weeklyUsage(
  records: readonly UsageRecord[],
  spend: readonly SpendEntry[],
): WeekUsage[] {
  const { weeks, week } = accumulate(records);
  for (const entry of spend) week(weekOf(entry.ts)).spendUsd += entry.usd;
  return [...weeks]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, acc]) => ({
      week: key,
      sessions: acc.sessions.size,
      searches: acc.searches.length,
      searchesWithOpenDoc: share(
        acc.searches.filter((s) => s.opened).length,
        acc.searches.length,
      ),
      searchesWithAi: share(
        acc.searches.filter((s) => s.ai).length,
        acc.searches.length,
      ),
      sessionsWithFilter: share(acc.filteredSessions.size, acc.sessions.size),
      spendUsd: acc.spendUsd,
    }));
}

const percent = (value: number): string => `${Math.round(value * 100)}%`;

/** Plain-text table for the terminal (the report is for the owner, in pt-BR). */
export function formatWeeklyUsage(rows: readonly WeekUsage[]): string {
  const header = [
    'Semana',
    'Sessões',
    'Buscas',
    '% c/ documento',
    '% c/ IA',
    '% sessões c/ filtro',
    'Gasto (US$)',
  ];
  const lines = rows.map((row) => [
    row.week,
    String(row.sessions),
    String(row.searches),
    percent(row.searchesWithOpenDoc),
    percent(row.searchesWithAi),
    percent(row.sessionsWithFilter),
    // Answers cost fractions of a cent: four decimals keep a week of light use visible.
    row.spendUsd.toFixed(4),
  ]);
  const table = [header, ...lines];
  const widths = header.map((_, column) =>
    Math.max(...table.map((cells) => (cells[column] ?? '').length)),
  );
  return table
    .map((cells) =>
      cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  '),
    )
    .join('\n');
}
