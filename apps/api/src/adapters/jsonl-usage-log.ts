import type { UsageRecord } from '@kb-chat/contracts';
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import type { UsageLogPort } from '../ports/usage-log.js';

/** Parses events.jsonl, skipping lines that are not records (a torn last write, manual edits). */
export function parseUsageLog(text: string): UsageRecord[] {
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const record = JSON.parse(line) as UsageRecord;
      return typeof record.ts === 'string' && typeof record.type === 'string'
        ? [record]
        : [];
    } catch {
      return [];
    }
  });
}

/** Usage log as JSONL under the local state folder (~/.kb-chat/events.jsonl). */
export class JsonlUsageLog implements UsageLogPort {
  constructor(private readonly file: string) {}

  async append(record: UsageRecord): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8');
  }

  async prune(cutoff: Date): Promise<number> {
    const text = await readFile(this.file, 'utf8').catch(() => null);
    if (text === null) return 0;
    const records = parseUsageLog(text);
    const kept = records.filter((r) => Date.parse(r.ts) >= cutoff.getTime());
    const removed =
      text.split('\n').filter((l) => l.trim()).length - kept.length;
    if (removed === 0) return 0;
    // Written aside and renamed, so a crash never leaves a half-written log.
    const temp = `${this.file}.tmp`;
    await writeFile(
      temp,
      kept.map((record) => `${JSON.stringify(record)}\n`).join(''),
      'utf8',
    );
    await rename(temp, this.file);
    return removed;
  }
}
