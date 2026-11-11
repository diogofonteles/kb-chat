import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spentThisMonth } from '../providers/app-ai-plan.js';
import { JsonlSpendLedger } from './jsonl-spend-ledger.js';
import { MemorySpendLedger } from './memory-spend-ledger.js';

const entry = (ts: string, usd: number) => ({
  ts,
  principal: 'p',
  model: 'm',
  inputTokens: 1,
  outputTokens: 1,
  usd,
  interrupted: false,
});

describe('spend by the day and the month in Recife (KBC-061)', () => {
  it('counts today from midnight in Recife, in the file and in memory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spend-'));
    for (const ledger of [
      new JsonlSpendLedger(join(dir, 'spend.jsonl')),
      new MemorySpendLedger(),
    ]) {
      await ledger.append(entry('2026-11-04T02:59:00.000Z', 1)); // 23:59 on 03/11
      expect(
        await ledger.spentToday('p', new Date('2026-11-04T02:59:30Z')),
      ).toBe(1);
      await ledger.append(entry('2026-11-04T03:00:00.000Z', 2)); // 00:00 on 04/11
      expect(
        await ledger.spentToday('p', new Date('2026-11-04T12:00:00Z')),
      ).toBe(2);
    }
  });

  it('counts the month from the 1st at midnight in Recife', async () => {
    const ledger = new MemorySpendLedger();
    await ledger.append(entry('2026-11-15T12:00:00.000Z', 1)); // mid-November
    await ledger.append(entry('2026-12-01T02:30:00.000Z', 4)); // 23:30 on 30/11
    expect(
      await spentThisMonth(ledger, 'p', new Date('2026-12-01T02:45:00Z')),
    ).toBe(5);
    await ledger.append(entry('2026-12-01T03:30:00.000Z', 3)); // 00:30 on 01/12
    expect(
      await spentThisMonth(ledger, 'p', new Date('2026-12-10T12:00:00Z')),
    ).toBe(3);
  });
});
