import type { LevelAuditEntry } from '@kb-chat/contracts';
import {
  SCALE_AUDIT_KINDS,
  type LevelAuditPage,
  type LevelAuditPort,
  type LevelAuditRead,
} from '../ports/level-audit.js';
import { pageOfAudit } from './level-audit-page.js';

/** The levels audit in memory (tests and an app built without a state folder). */
export class MemoryLevelAudit implements LevelAuditPort {
  readonly entries: LevelAuditEntry[] = [];

  async append(entry: LevelAuditEntry): Promise<void> {
    this.entries.push(entry);
  }

  async appendMany(entries: readonly LevelAuditEntry[]): Promise<void> {
    this.entries.push(...entries);
  }

  read(query: LevelAuditRead): Promise<LevelAuditPage> {
    const monthOf = (entry: LevelAuditEntry) => entry.at.slice(0, 7);
    const months = [...new Set(this.entries.map(monthOf))];
    const load = async (month: string) =>
      this.entries.filter((entry) => monthOf(entry) === month);
    return pageOfAudit({ months, load }, query);
  }

  async scaleLines(): Promise<readonly LevelAuditEntry[]> {
    return this.entries
      .filter((entry) => SCALE_AUDIT_KINDS.has(entry.kind))
      .reverse();
  }
}
