import { appendFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LevelAuditEntry } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import { FsLevelAudit } from './fs-level-audit.js';
import { MemoryLevelAudit } from './memory-level-audit.js';

const line = (at: string, target: string): LevelAuditEntry => ({
  at,
  by: 'owner@example.com',
  kind: 'item.level',
  collection: 'hermetismo',
  target,
  before: 'qs',
  after: 'ci',
});

const LINES = [
  line('2026-09-30T10:00:00.000Z', 'a'),
  line('2026-10-01T10:00:00.000Z', 'b'),
  line('2026-10-02T10:00:00.000Z', 'c'),
  line('2026-11-01T10:00:00.000Z', 'd'),
  line('2026-11-02T10:00:00.000Z', 'e'),
];

const all = () => true;

async function onDisk(): Promise<FsLevelAudit> {
  const dir = await mkdtemp(join(tmpdir(), 'kbchat-level-audit-'));
  const audit = new FsLevelAudit(dir);
  await audit.appendMany(LINES);
  return audit;
}

describe.each([
  ['on disk', onDisk],
  [
    'in memory',
    async () => {
      const audit = new MemoryLevelAudit();
      await audit.appendMany(LINES);
      return audit;
    },
  ],
])('Levels audit read %s (KBC-108 FR-4)', (_name, make) => {
  it('pages newest first across months, the cursor going on where the last page stopped', async () => {
    const audit = await make();
    const first = await audit.read({ accepts: all, limit: 2 });
    expect(first.entries.map((one) => one.target)).toEqual(['e', 'd']);
    expect(first.next).toEqual({ month: '2026-10', index: 2 });
    const second = await audit.read({
      accepts: all,
      limit: 2,
      ...(first.next && { after: first.next }),
    });
    expect(second.entries.map((one) => one.target)).toEqual(['c', 'b']);
    const third = await audit.read({
      accepts: all,
      limit: 2,
      ...(second.next && { after: second.next }),
    });
    expect(third.entries.map((one) => one.target)).toEqual(['a']);
    expect(third.next).toBeNull();
  });

  it('reads only the months asked and the lines the filter keeps', async () => {
    const audit = await make();
    const october = await audit.read({
      accepts: (entry) => entry.target !== 'b',
      fromMonth: '2026-10',
      toMonth: '2026-10',
      limit: 10,
    });
    expect(october.entries.map((one) => one.target)).toEqual(['c']);
    expect(october.next).toBeNull();
  });
});

describe('FsLevelAudit read (KBC-108)', () => {
  it('answers an empty page before the first line, and skips a torn line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kbchat-level-audit-'));
    const audit = new FsLevelAudit(dir);
    expect(await audit.read({ accepts: all, limit: 5 })).toEqual({
      entries: [],
      next: null,
    });
    await audit.append(LINES[0] ?? line('2026-09-01T00:00:00.000Z', 'x'));
    await appendFile(join(dir, 'levels-2026-09.jsonl'), '{"at": "2026-09\n');
    const read = await audit.read({ accepts: all, limit: 5 });
    expect(read.entries.map((one) => one.target)).toEqual(['a']);
    expect(await readFile(join(dir, 'levels-2026-09.jsonl'), 'utf8')).toContain(
      '"target":"a"',
    );
  });
});
