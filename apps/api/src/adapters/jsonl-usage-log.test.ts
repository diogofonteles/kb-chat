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
    // Retention decides by date only: the line without a readable date goes, the others stay.
    expect(await new JsonlUsageLog(file).prune(CUTOFF)).toBe(2);
  });

  it('keeps recent lines of an older format and reads them as typed searches (QA BUG-1)', async () => {
    const file = tempFile();
    const legacy = {
      type: 'search',
      question: 'ritmo',
      mode: 'all',
      filterCount: 0,
      total: 3,
      tookMs: 10,
      ts: daysAgo(2),
      principal: 'owner',
      sessionId: 's',
    };
    await writeFile(file, `${JSON.stringify(legacy)}\n`);
    expect(await new JsonlUsageLog(file).prune(CUTOFF)).toBe(0);
    const [record] = parseUsageLog(await readFile(file, 'utf8'));
    expect(record).toMatchObject({ type: 'search', origin: 'typed' });
  });
});
