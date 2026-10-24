import type { UsageRecord } from '@kb-chat/contracts';
import { mkdtempSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JsonlUsageLog,
  parseUsageLog,
} from '../../adapters/jsonl-usage-log.js';
import { MemoryUsageLog } from '../../adapters/memory-usage-log.js';
import type { CatalogEntry } from '../catalog/index.js';
import { topSuggestions } from './suggestions.js';
import { formatWeeklyUsage, weekOf, weeklyUsage } from './weekly-usage.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();

const entry = (concepts: string[]): CatalogEntry =>
  ({ concepts }) as unknown as CatalogEntry;

const record = (
  ts: string,
  sessionId: string,
  event: Partial<UsageRecord> & Pick<UsageRecord, 'type'>,
): UsageRecord =>
  ({ ts, sessionId, principal: 'owner', ...event }) as UsageRecord;

const search = (ts: string, sessionId: string, filterCount = 0) =>
  record(ts, sessionId, {
    type: 'search',
    question: 'q',
    mode: 'all',
    filterCount,
    total: 1,
    tookMs: 10,
  });

describe('topSuggestions (KBC-006 BR-1, AC-1)', () => {
  it('returns the six subjects with the most documents, ties alphabetically', () => {
    const counts: Record<string, number> = {
      Alquimia: 9,
      Cabala: 8,
      Tarô: 7,
      Gnosticismo: 6,
      Astrologia: 5,
      Ritmo: 5,
      Ocultismo: 2,
      Magia: 1,
    };
    const entries = Object.entries(counts).flatMap(([concept, n]) =>
      Array.from({ length: n }, () => entry([concept])),
    );
    expect(topSuggestions(entries).items).toEqual([
      { concept: 'Alquimia', count: 9 },
      { concept: 'Cabala', count: 8 },
      { concept: 'Tarô', count: 7 },
      { concept: 'Gnosticismo', count: 6 },
      { concept: 'Astrologia', count: 5 },
      { concept: 'Ritmo', count: 5 },
    ]);
  });

  it('is empty for a collection without subjects', () => {
    expect(topSuggestions([entry([])]).items).toEqual([]);
  });
});

describe('usage log retention (KBC-006 BR-3, AC-5)', () => {
  it('removes events older than the cutoff and keeps the rest', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kbchat-prune-')), 'e.jsonl');
    const log = new JsonlUsageLog(file);
    await log.append(record(daysAgo(91), 's', { type: 'ai_cancel' }));
    await log.append(record(daysAgo(89), 's', { type: 'ai_cancel' }));
    expect(await log.prune(new Date(NOW - 90 * DAY))).toBe(1);
    const left = parseUsageLog(await readFile(file, 'utf8'));
    expect(left.map((r) => r.ts)).toEqual([daysAgo(89)]);
    expect(await log.prune(new Date(NOW - 90 * DAY))).toBe(0);
  });

  it('drops unreadable lines and copes with a missing file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kbchat-prune-'));
    expect(
      await new JsonlUsageLog(join(dir, 'none.jsonl')).prune(new Date()),
    ).toBe(0);
    const file = join(dir, 'e.jsonl');
    await writeFile(
      file,
      `{"torn\n${JSON.stringify(record(daysAgo(1), 's', { type: 'ai_cancel' }))}\n`,
    );
    expect(await new JsonlUsageLog(file).prune(new Date(NOW - 90 * DAY))).toBe(
      1,
    );
    expect(parseUsageLog(await readFile(file, 'utf8'))).toHaveLength(1);
  });

  it('prunes the in-memory log the same way', async () => {
    const log = new MemoryUsageLog();
    await log.append(record(daysAgo(91), 's', { type: 'ai_cancel' }));
    await log.append(record(daysAgo(1), 's', { type: 'ai_cancel' }));
    expect(await log.prune(new Date(NOW - 90 * DAY))).toBe(1);
    expect(log.records).toHaveLength(1);
  });
});

describe('weeklyUsage (KBC-006 BR-4, AC-6)', () => {
  // Week of Monday 2026-10-19: two sessions, four searches.
  const events: UsageRecord[] = [
    search('2026-10-20T10:00:00Z', 'a'),
    record('2026-10-20T10:01:00Z', 'a', { type: 'open_doc', position: 1 }),
    record('2026-10-20T10:02:00Z', 'a', { type: 'open_doc', position: 3 }),
    search('2026-10-20T10:05:00Z', 'a'),
    record('2026-10-20T10:06:00Z', 'a', { type: 'ai_answer', usd: 0.002 }),
    search('2026-10-21T09:00:00Z', 'b', 1),
    record('2026-10-21T09:01:00Z', 'b', { type: 'filter', filterCount: 2 }),
    search('2026-10-21T09:02:00Z', 'b', 2),
    record('2026-10-21T09:03:00Z', 'b', { type: 'ai_cancel' }),
    record('2026-10-21T09:04:00Z', 'b', { type: 'open_doc', position: 1 }),
    // Next week: one session without filters.
    search('2026-10-26T08:00:00Z', 'c'),
  ];
  const spend = [
    { ts: '2026-10-20T10:06:00Z', usd: 0.002 },
    { ts: '2026-10-21T09:03:00Z', usd: 0.001 },
  ].map((s) => ({
    ...s,
    principal: 'owner',
    model: 'm',
    inputTokens: 1,
    outputTokens: 1,
    interrupted: false,
  }));

  it('computes sessions, searches and the shares of the brief per week', () => {
    expect(weeklyUsage(events, spend)).toEqual([
      {
        week: '2026-10-19',
        sessions: 2,
        searches: 4,
        searchesWithOpenDoc: 0.5,
        searchesWithAi: 0.5,
        sessionsWithFilter: 0.5,
        spendUsd: 0.003,
      },
      {
        week: '2026-10-26',
        sessions: 1,
        searches: 1,
        searchesWithOpenDoc: 0,
        searchesWithAi: 0,
        sessionsWithFilter: 0,
        spendUsd: 0,
      },
    ]);
  });

  it('prints one aligned line per week', () => {
    const text = formatWeeklyUsage(weeklyUsage(events, spend));
    expect(text.split('\n')).toHaveLength(3);
    expect(text).toMatch(/2026-10-19\s+2\s+4\s+50%\s+50%\s+50%\s+0\.0030/);
  });

  it('starts weeks on Monday', () => {
    expect(weekOf('2026-10-25T23:00:00Z')).toBe('2026-10-19');
    expect(weekOf('2026-10-26T00:00:00Z')).toBe('2026-10-26');
  });
});
