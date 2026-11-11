import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
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

  it('a second page holds every line the first left, in one month', async () => {
    const audit = await make();
    const many = Array.from({ length: 23 }, (_, n) =>
      line(`2026-12-01T10:00:${String(n).padStart(2, '0')}.000Z`, `m${n}`),
    );
    await audit.appendMany(many);
    const december = { accepts: all, fromMonth: '2026-12', limit: 20 };
    const first = await audit.read(december);
    expect(first.entries).toHaveLength(20);
    const second = await audit.read({
      ...december,
      ...(first.next && { after: first.next }),
    });
    expect(second.entries.map((one) => one.target)).toEqual(['m2', 'm1', 'm0']);
    expect(second.next).toBeNull();
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

describe('FsLevelAudit after a torn append and across pages (R2-4, R2-5)', () => {
  it('a mark written on a fresh line is read even after a torn last line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kbchat-level-audit-'));
    const audit = new FsLevelAudit(dir);
    await audit.append(line('2026-09-01T00:00:00.000Z', 'a'));
    await appendFile(
      join(dir, 'levels-2026-09.jsonl'),
      '{"at":"2026-09-01T00:',
    );
    await audit.append({
      ...line('2026-09-01T00:00:01.000Z', 'mark'),
      kind: 'scale.undone',
    });
    const read = await audit.read({ accepts: all, limit: 5 });
    expect(read.entries.map((one) => one.target)).toEqual(['mark', 'a']);
  });

  it('reads a month file again only once it changed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kbchat-level-audit-'));
    const reads: string[] = [];
    const audit = new FsLevelAudit(dir, {
      readText: async (file) => {
        reads.push(file);
        return readFile(file, 'utf8');
      },
    });
    await audit.appendMany(LINES);
    // The scale lines every page of the history asks for (R2-5, R3-2).
    await audit.scaleLines();
    await audit.scaleLines();
    expect(reads).toHaveLength(3);
    await audit.append({
      ...line('2026-11-03T10:00:00.000Z', 'f'),
      kind: 'scale.create',
    });
    const again = await audit.scaleLines();
    expect(reads).toHaveLength(4);
    expect(again[0]?.target).toBe('f');
  });
});

describe('FsLevelAudit memory, torn lines and twelve months (R3-2, R3-3)', () => {
  it('R3-3: the first line of any append after a torn one is read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kbchat-level-audit-'));
    const audit = new FsLevelAudit(dir);
    await audit.append(line('2026-09-01T00:00:00.000Z', 'a'));
    await appendFile(
      join(dir, 'levels-2026-09.jsonl'),
      '{"at":"2026-09-01T00:',
    );
    await audit.appendMany([
      line('2026-09-01T00:00:01.000Z', 'b'),
      line('2026-09-01T00:00:02.000Z', 'c'),
    ]);
    const read = await audit.read({ accepts: all, limit: 5 });
    expect(read.entries.map((one) => one.target)).toEqual(['c', 'b', 'a']);
  });

  it('R3-2: keeps only the scale lines of every month and few months whole', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kbchat-level-audit-'));
    const audit = new FsLevelAudit(dir);
    const months = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
    await audit.appendMany(
      months.flatMap((month) => [
        line(`${month}-01T00:00:00.000Z`, `item-${month}`),
        {
          ...line(`${month}-01T00:00:01.000Z`, `level-${month}`),
          kind: 'scale.create' as const,
        },
      ]),
    );
    const scale = await audit.scaleLines();
    expect(scale.map((one) => one.target)).toEqual(
      [...months].reverse().map((month) => `level-${month}`),
    );
    await audit.read({ accepts: all, limit: 50 });
    expect(audit.monthsKeptWhole()).toBeLessThanOrEqual(2);
  });

  it('R3-2: a line older than twelve months goes when a new month starts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kbchat-level-audit-'));
    for (const month of ['2025-09', '2025-10', '2025-11'])
      await writeFile(
        join(dir, `levels-${month}.jsonl`),
        `${JSON.stringify(line(`${month}-15T00:00:00.000Z`, month))}\n`,
      );
    const audit = new FsLevelAudit(dir);
    await audit.append(line('2026-11-01T00:00:00.000Z', 'now'));
    expect((await readdir(dir)).sort()).toEqual([
      'levels-2025-11.jsonl',
      'levels-2026-11.jsonl',
    ]);
  });
});
