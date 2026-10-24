import type { UsageRecord } from '@kb-chat/contracts';
import type { UsageLogPort } from '../ports/usage-log.js';

/** Usage log kept in memory (tests and runs without a state folder). */
export class MemoryUsageLog implements UsageLogPort {
  records: UsageRecord[] = [];

  async append(record: UsageRecord): Promise<void> {
    this.records.push(record);
  }

  async prune(cutoff: Date): Promise<number> {
    const before = this.records.length;
    this.records = this.records.filter(
      (record) => Date.parse(record.ts) >= cutoff.getTime(),
    );
    return before - this.records.length;
  }
}
