import { z } from 'zod';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SpendEntry, SpendLedgerPort } from '../ports/spend-ledger.js';

const startOfLocalDay = (now: Date): number =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

const spendEntrySchema = z.object({
  ts: z.iso.datetime(),
  principal: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  usd: z.number().nonnegative(),
  interrupted: z.boolean(),
  /** A lent subscription's turn (KBC-024). */
  billing: z.literal('subscription').optional(),
});

/** Parses spend.jsonl, skipping lines that are not valid entries. */
export function parseSpendLedger(text: string): SpendEntry[] {
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const parsed = spendEntrySchema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}

/** Spend ledger as a JSONL file under the local state folder (~/.kb-chat/spend.jsonl). */
export class JsonlSpendLedger implements SpendLedgerPort {
  constructor(private readonly file: string) {}

  async append(entry: SpendEntry): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  async spentToday(principal: string, now = new Date()): Promise<number> {
    return this.spentSince(principal, new Date(startOfLocalDay(now)));
  }

  async spentSince(principal: string, since: Date): Promise<number> {
    const text = await readFile(this.file, 'utf8').catch(() => '');
    return parseSpendLedger(text)
      .filter(
        (entry) =>
          entry.principal === principal &&
          Date.parse(entry.ts) >= since.getTime(),
      )
      .reduce((sum, entry) => sum + entry.usd, 0);
  }
}
