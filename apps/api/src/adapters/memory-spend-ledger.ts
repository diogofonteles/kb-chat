import { startOfAppDay } from '../app-calendar.js';
import type { SpendEntry, SpendLedgerPort } from '../ports/spend-ledger.js';

/** Spend ledger kept in memory (tests and runs without a state folder). */
export class MemorySpendLedger implements SpendLedgerPort {
  readonly entries: SpendEntry[] = [];

  async append(entry: SpendEntry): Promise<void> {
    this.entries.push(entry);
  }

  async spentToday(principal: string, now = new Date()): Promise<number> {
    return this.spentSince(principal, startOfAppDay(now));
  }

  async spentSince(principal: string, since: Date): Promise<number> {
    return this.entries
      .filter(
        (entry) =>
          entry.principal === principal &&
          Date.parse(entry.ts) >= since.getTime(),
      )
      .reduce((sum, entry) => sum + entry.usd, 0);
  }
}
