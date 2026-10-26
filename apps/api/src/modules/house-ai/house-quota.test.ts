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

  it('starts again the next day', async () => {
    let now = new Date(2026, 9, 26, 23, 0);
    const quota = new HouseQuota({
      ledger: new MemoryHouseUsage(),
      now: () => now,
    });
    await quota.reserve('p', { profile: 'fast', dailyLimit: 1 });
    expect(await quota.remaining('p', 1)).toBe(0);
    now = new Date(2026, 9, 27, 0, 1);
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
