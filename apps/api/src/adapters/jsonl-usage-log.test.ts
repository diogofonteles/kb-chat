import { mkdtempSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aRecord } from '../../test/usage-factories.js';
import { JsonlUsageLog, parseUsageLog } from './jsonl-usage-log.js';
import { MemoryUsageLog } from './memory-usage-log.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();
const CUTOFF = new Date(NOW - 90 * DAY);
const cancel = (ts: string) => aRecord(ts, 's', { type: 'ai_cancel' });
const tempFile = () =>
  join(mkdtempSync(join(tmpdir(), 'kbchat-usage-')), 'events.jsonl');

describe('JsonlUsageLog retention (KBC-006 BR-3, AC-5)', () => {
  it('removes the 91-day event and keeps the 89-day one', async () => {
    const file = tempFile();
    const log = new JsonlUsageLog(file);
    await log.append(cancel(daysAgo(91)));
    await log.append(cancel(daysAgo(89)));
    expect(await log.prune(CUTOFF)).toBe(1);
    const left = parseUsageLog(await readFile(file, 'utf8'));
    expect(left.map((r) => r.ts)).toEqual([daysAgo(89)]);
    expect(await log.prune(CUTOFF)).toBe(0);
  });

  it('copes with a missing file', async () => {
    expect(await new JsonlUsageLog(tempFile()).prune(CUTOFF)).toBe(0);
  });

  it('prunes the in-memory log the same way', async () => {
    const log = new MemoryUsageLog();
    await log.append(cancel(daysAgo(91)));
    await log.append(cancel(daysAgo(1)));
    expect(await log.prune(CUTOFF)).toBe(1);
    expect(log.records).toHaveLength(1);
  });
});

describe('parseUsageLog', () => {
  it('writes a format version and skips torn, invalid or unknown lines', async () => {
    const file = tempFile();
    await new JsonlUsageLog(file).append(cancel(daysAgo(1)));
    const valid = await readFile(file, 'utf8');
    expect(JSON.parse(valid).v).toBe(1);
    await writeFile(
      file,
      [
        '{"torn',
        JSON.stringify({ ...cancel(daysAgo(1)), ts: 'ontem' }),
        JSON.stringify({ ...cancel(daysAgo(1)), type: 'export' }),
        valid.trim(),
      ].join('\n'),
    );
    expect(parseUsageLog(await readFile(file, 'utf8'))).toHaveLength(1);
    expect(await new JsonlUsageLog(file).prune(CUTOFF)).toBe(3);
  });
});
