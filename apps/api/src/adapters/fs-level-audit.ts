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

  append(entry: LevelAuditEntry): Promise<void> {
    return this.appendMany([entry]);
  }

  async appendMany(entries: readonly LevelAuditEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const byMonth = new Map<string, string[]>();
    for (const entry of entries) {
      const month = entry.at.slice(0, 7);
      byMonth.set(month, [
        ...(byMonth.get(month) ?? []),
        JSON.stringify(entry),
      ]);
    }
    for (const [month, lines] of byMonth)
      await this.write(`levels-${month}.jsonl`, `${lines.join('\n')}\n`);
  }

  private async write(name: string, text: string): Promise<void> {
    const file = await open(join(this.dir, name), 'a', 0o600);
    try {
      await file.appendFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
  }
}
