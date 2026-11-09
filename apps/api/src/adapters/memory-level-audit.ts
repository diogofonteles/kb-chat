import type { LevelAuditEntry } from '@kb-chat/contracts';
import type { LevelAuditPort } from '../ports/level-audit.js';

/** The levels audit in memory (tests and an app built without a state folder). */
export class MemoryLevelAudit implements LevelAuditPort {
  readonly entries: LevelAuditEntry[] = [];

  async append(entry: LevelAuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}
