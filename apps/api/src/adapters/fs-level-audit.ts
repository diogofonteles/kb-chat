import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { LevelAuditEntry } from '@kb-chat/contracts';
import type { LevelAuditPort } from '../ports/level-audit.js';

/**
 * `<state>/audit/levels-YYYY-MM.jsonl`, 0600, one JSON line per change (ADR 0036 §11):
 * appended and synced before `append` resolves, so a change the API answered is never
 * missing from the audit.
 */
export class FsLevelAudit implements LevelAuditPort {
  constructor(private readonly dir: string) {}

  async append(entry: LevelAuditEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const month = entry.at.slice(0, 7);
    const file = await open(
      join(this.dir, `levels-${month}.jsonl`),
      'a',
      0o600,
    );
    try {
      await file.appendFile(`${JSON.stringify(entry)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
  }
}
