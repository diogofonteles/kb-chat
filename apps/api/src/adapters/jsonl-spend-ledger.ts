import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SpendEntry, SpendLedgerPort } from '../ports/spend-ledger.js';

const startOfLocalDay = (now: Date): number =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

function parseLine(line: string): SpendEntry | null {
  try {
    return JSON.parse(line) as SpendEntry;
  } catch {
    return null;
  }
}

/** Spend ledger as a JSONL file under the local state folder (~/.kb-chat/spend.jsonl). */
export class JsonlSpendLedger implements SpendLedgerPort {
  constructor(private readonly file: string) {}

  async append(entry: SpendEntry): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  async spentToday(principal: string, now = new Date()): Promise<number> {
    const text = await readFile(this.file, 'utf8').catch(() => '');
    const since = startOfLocalDay(now);
    return text
      .split('\n')
      .map(parseLine)
      .filter((entry): entry is SpendEntry => entry !== null)
      .filter(
        (entry) =>
          entry.principal === principal && Date.parse(entry.ts) >= since,
      )
      .reduce((sum, entry) => sum + entry.usd, 0);
  }
}
