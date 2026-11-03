import type { ActAsAuditEntry } from '@kb-chat/contracts';
import type { ActAsAuditPort } from '../ports/act-as-audit.js';

/** The act-as audit in memory (tests and the E2E server). */
export class MemoryActAsAudit implements ActAsAuditPort {
  private readonly entries: ActAsAuditEntry[] = [];

  async append(entry: ActAsAuditEntry): Promise<void> {
    this.entries.push(entry);
  }

  async since(since: Date): Promise<ActAsAuditEntry[]> {
    const from = since.toISOString();
    return this.entries.filter((entry) => entry.at >= from);
  }

  async prune(before: Date): Promise<number> {
    const month = before.toISOString().slice(0, 7);
    const kept = this.entries.filter((entry) => entry.at.slice(0, 7) >= month);
    const dropped = this.entries.length - kept.length;
    this.entries.splice(0, this.entries.length, ...kept);
    return dropped;
  }
}
