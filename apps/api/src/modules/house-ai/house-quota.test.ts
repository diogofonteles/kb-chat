import { describe, expect, it } from 'vitest';
import { MemoryHouseUsage } from '../../adapters/house-usage-ledgers.js';
import { HouseQuota } from './house-quota.js';

describe('HouseQuota (KBC-022 AC-5)', () => {
  it('counts fast 1, deep 2, exhaustive 5 and refuses past the daily quota', async () => {
    const quota = new HouseQuota({ ledger: new MemoryHouseUsage() });
    const deep = await quota.reserve('p', { profile: 'deep', dailyLimit: 2 });
    expect(deep.remaining).toBe(0);
    await expect(
      quota.reserve('p', { profile: 'fast', dailyLimit: 2 }),
    ).rejects.toMatchObject({ code: 'HOUSE_QUOTA_EXHAUSTED' });
    expect(await quota.remaining('other', 2)).toBe(2);
    await expect(
      quota.reserve('q', { profile: 'exhaustive', dailyLimit: 4 }),
    ).rejects.toMatchObject({ code: 'HOUSE_QUOTA_EXHAUSTED' });
  });

  it('gives the units back once on refund', async () => {
    const quota = new HouseQuota({ ledger: new MemoryHouseUsage() });
    const taken = await quota.reserve('p', { profile: 'fast', dailyLimit: 1 });
    await taken.refund();
    await taken.refund();
    expect(await quota.remaining('p', 1)).toBe(1);
  });

  it('starts again the next day, in Recife', async () => {
    let now = new Date('2026-10-27T02:00:00Z'); // 23:00 on 26/10 in Recife
    const quota = new HouseQuota({
      ledger: new MemoryHouseUsage(),
      now: () => now,
    });
    await quota.reserve('p', { profile: 'fast', dailyLimit: 1 });
    expect(await quota.remaining('p', 1)).toBe(0);
    now = new Date('2026-10-27T03:01:00Z'); // 00:01 on 27/10 in Recife
    expect(await quota.remaining('p', 1)).toBe(1);
  });

  it('serializes parallel reservations', async () => {
    const quota = new HouseQuota({ ledger: new MemoryHouseUsage() });
    const results = await Promise.allSettled([
      quota.reserve('p', { profile: 'fast', dailyLimit: 1 }),
      quota.reserve('p', { profile: 'fast', dailyLimit: 1 }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
  });
});

describe('HouseQuota counts the day in Recife (KBC-061)', () => {
  it('gives the day back at midnight in Recife, not at 21:00 (Mariano’s report)', async () => {
    const entries: { ts: string; units: number }[] = [];
    let now = new Date('2026-11-01T01:06:00Z'); // 22:06 on 31/10 in Recife
    const quota = new HouseQuota({
      ledger: {
        append: async (entry) => {
          entries.push(entry);
        },
        unitsSince: async (_principal, since) =>
          entries
            .filter((entry) => Date.parse(entry.ts) >= since.getTime())
            .reduce((sum, entry) => sum + entry.units, 0),
      },
      now: () => now,
    });
    await quota.reserve('mariano', { profile: 'exhaustive', dailyLimit: 5 });
    expect(await quota.remaining('mariano', 5)).toBe(0);
    now = new Date('2026-11-01T02:59:00Z'); // 23:59 on 31/10 in Recife: still that day
    expect(await quota.remaining('mariano', 5)).toBe(0);
    now = new Date('2026-11-01T12:34:00Z'); // 09:34 on 01/11 in Recife: a new day
    expect(await quota.remaining('mariano', 5)).toBe(5);
  });
});
