import type { UsageRecord } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import { parseSpendLedger } from '../../adapters/jsonl-spend-ledger.js';
import { aRecord, aSearch, aSpend } from '../../../test/usage-factories.js';
import { formatWeeklyUsage, weekOf, weeklyUsage } from './weekly-usage.js';

describe('weeklyUsage (KBC-006 BR-4, AC-6)', () => {
  // Week of Monday 2026-10-19: two sessions, four new searches.
  const events: UsageRecord[] = [
    aSearch('2026-10-20T10:00:00Z', 'a'),
    aRecord('2026-10-20T10:01:00Z', 'a', { type: 'open_doc', position: 1 }),
    aRecord('2026-10-20T10:02:00Z', 'a', { type: 'open_doc', position: 3 }),
    aSearch('2026-10-20T10:05:00Z', 'a', {
      origin: 'suggestion',
      filterCount: 1,
    }),
    aRecord('2026-10-20T10:06:00Z', 'a', { type: 'ai_answer', usd: 0.002 }),
    aSearch('2026-10-21T09:00:00Z', 'b'),
    aRecord('2026-10-21T09:01:00Z', 'b', { type: 'filter', filterCount: 2 }),
    // A refine re-runs the same search: the documents opened after it count for that search.
    aSearch('2026-10-21T09:01:30Z', 'b', { origin: 'refine', filterCount: 2 }),
    aSearch('2026-10-21T09:02:00Z', 'b', { origin: 'mode' }),
    aRecord('2026-10-21T09:03:00Z', 'b', { type: 'ai_cancel' }),
    aRecord('2026-10-21T09:04:00Z', 'b', { type: 'open_doc', position: 1 }),
    // Next week: one session without filters.
    aSearch('2026-10-26T08:00:00Z', 'c'),
  ];
  const spend = [
    aSpend('2026-10-20T10:06:00Z', 0.002),
    aSpend('2026-10-21T09:03:00Z', 0.001),
  ];

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
        mediaHitsOpened: 0,
      },
      {
        week: '2026-10-26',
        sessions: 1,
        searches: 1,
        searchesWithOpenDoc: 0,
        searchesWithAi: 0,
        sessionsWithFilter: 0,
        spendUsd: 0,
        mediaHitsOpened: 0,
      },
    ]);
  });

  it('does not count a suggestion’s own subject filter as the reader filtering', () => {
    const [week] = weeklyUsage(
      [
        aSearch('2026-10-20T10:00:00Z', 'a', {
          origin: 'suggestion',
          filterCount: 1,
        }),
      ],
      [],
    );
    expect(week?.sessionsWithFilter).toBe(0);
  });

  it('counts the spoken passages opened (KBC-039 FR-4)', () => {
    const opened = {
      type: 'media_hit_opened',
      mediaId: '6f1c2b9b-8a11-4d0a-9d55-0b6f1f0e6a3e',
      startMs: 495_000,
      position: 1,
    } as const;
    const [week] = weeklyUsage(
      [
        aSearch('2026-10-20T10:00:00Z', 'a'),
        aRecord('2026-10-20T10:01:00Z', 'a', opened),
        aRecord('2026-10-20T10:02:00Z', 'a', opened),
      ],
      [],
    );
    expect(week?.mediaHitsOpened).toBe(2);
    const [header, line] = formatWeeklyUsage(week ? [week] : []).split('\n');
    expect(header?.trim()).toMatch(/Trechos ouvidos$/);
    expect(line?.trim()).toMatch(/\s2$/);
  });

  it('prints one aligned line per week', () => {
    const text = formatWeeklyUsage(weeklyUsage(events, spend));
    expect(text.split('\n')).toHaveLength(3);
    expect(text).toMatch(/2026-10-19\s+2\s+4\s+50%\s+50%\s+50%\s+0\.0030/);
  });

  it('starts weeks on Monday (UTC)', () => {
    expect(weekOf('2026-10-25T23:00:00Z')).toBe('2026-10-19');
    expect(weekOf('2026-10-26T00:00:00Z')).toBe('2026-10-26');
  });

  it('reads only valid spend lines', () => {
    const text = [
      JSON.stringify(aSpend('2026-10-20T10:06:00Z', 0.002)),
      '{"usd": "muito"}',
      '{"torn',
    ].join('\n');
    expect(parseSpendLedger(text)).toHaveLength(1);
  });
});
