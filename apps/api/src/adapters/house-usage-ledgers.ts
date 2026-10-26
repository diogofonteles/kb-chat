import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { researchProfileSchema } from '@kb-chat/contracts';
import { z } from 'zod';
import type { HouseUsageEntry, HouseUsagePort } from '../ports/house-usage.js';

const entrySchema = z.object({
  ts: z.iso.datetime(),
  principal: z.string(),
  units: z.number().int(),
  profile: researchProfileSchema,
});

const sumSince = (
  entries: readonly HouseUsageEntry[],
  principal: string,
  since: Date,
): number =>
  entries
    .filter(
      (e) => e.principal === principal && Date.parse(e.ts) >= since.getTime(),
    )
    .reduce((sum, e) => sum + e.units, 0);

function parseLines(text: string): HouseUsageEntry[] {
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const parsed = entrySchema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}

/** house-usage.jsonl under the state folder (KBC-022). */
export class JsonlHouseUsage implements HouseUsagePort {
  constructor(private readonly file: string) {}

  async append(entry: HouseUsageEntry): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  async unitsSince(principal: string, since: Date): Promise<number> {
    const text = await readFile(this.file, 'utf8').catch(() => '');
    return sumSince(parseLines(text), principal, since);
  }
}

/** The same in memory (tests). */
export class MemoryHouseUsage implements HouseUsagePort {
  readonly entries: HouseUsageEntry[] = [];

  async append(entry: HouseUsageEntry): Promise<void> {
    this.entries.push(entry);
  }

  async unitsSince(principal: string, since: Date): Promise<number> {
    return sumSince(this.entries, principal, since);
  }
}
