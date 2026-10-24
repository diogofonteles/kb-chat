import type { UsageRecord } from '@kb-chat/contracts';

/** Append-only local usage log (KBC-006); nothing leaves this computer. */
export interface UsageLogPort {
  append(record: UsageRecord): Promise<void>;
  /** Drops records older than `cutoff` (retention, BR-3); returns how many were removed. */
  prune(cutoff: Date): Promise<number>;
}
