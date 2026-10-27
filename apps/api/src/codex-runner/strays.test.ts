import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStray, parseStat, reapStrays, type ProcessEntry } from './strays.js';

/** A /proc/<pid>/stat line: pid (comm) state ppid ... with field 22 the start time. */
const stat = (
  pid: number,
  comm: string,
  {
    parent,
    start = '100',
    state = 'S',
  }: { parent: number; start?: string; state?: string },
) =>
  `${pid} (${comm}) ${state} ${parent} ${Array.from({ length: 17 }, () => '0').join(' ')} ${start} 0`;

const tree = (
  entries: Record<number, [parent: number, start?: string]>,
): Map<number, ProcessEntry> =>
  new Map(
    Object.entries(entries).map(([pid, [parent, start = '1']]) => [
      Number(pid),
      { parent, start },
    ]),
  );

describe('parseStat (ADR 0020)', () => {
  it('reads the parent and start time, whatever the command name holds', () => {
    expect(parseStat(stat(42, 'node', { parent: 7, start: '555' }))).toEqual({
      parent: 7,
      start: '555',
      state: 'S',
    });
    expect(parseStat(stat(42, 'a) b (c', { parent: 9, start: '7' }))).toEqual({
      parent: 9,
      start: '7',
      state: 'S',
    });
    expect(parseStat('')).toBeNull();
    expect(parseStat('42 node S x')).toBeNull();
  });
});

describe('isStray (ADR 0020)', () => {
  // pid 1 tini, 10 the runner, 11 its Codex turn, 12 the turn's child, 20 a docker exec
  // (parent 0), 30 a detached former turn (re-parented to init) with child 31.
  const processes = tree({
    1: [0],
    10: [1],
    11: [10],
    12: [11],
    20: [0],
    21: [20],
    30: [1],
    31: [30],
  });

  it('keeps init, the runner, its family and what comes from outside', () => {
    for (const pid of [1, 10, 11, 12, 20, 21])
      expect(isStray(processes, pid, 10)).toBe(false);
  });

  it('takes a former turn with its children', () => {
    expect(isStray(processes, 30, 10)).toBe(true);
    expect(isStray(processes, 31, 10)).toBe(true);
  });

  it('takes what it cannot follow: a missing parent, a chain too deep', () => {
    expect(isStray(tree({ 40: [39] }), 40, 10)).toBe(true);
    const chain: Record<number, [number]> = { 1000: [1] };
    for (let pid = 1001; pid < 1700; pid += 1) chain[pid] = [pid - 1];
    expect(isStray(tree(chain), 1699, 10)).toBe(true);
  });
});

describe('reapStrays (review R1)', () => {
  /** A fake /proc whose pids no process can have (above any system's pid limit). */
  async function fakeProc(entries: Record<number, number | [number, string]>) {
    const proc = await mkdtemp(join(tmpdir(), 'kbchat-proc-'));
    for (const [pid, value] of Object.entries(entries)) {
      const [parent, state] = Array.isArray(value) ? value : [value, 'S'];
      await mkdir(join(proc, pid));
      await writeFile(
        join(proc, pid, 'stat'),
        stat(Number(pid), 'node', { parent, state }),
      );
    }
    return proc;
  }

  it('lets the turn start when nothing is left behind', async () => {
    const proc = await fakeProc({ 1: 0, 4999990: 1 });
    await expect(reapStrays(4999990, proc)).resolves.toBeUndefined();
  });

  it('refuses the turn when strays will not go away (fails closed)', async () => {
    // A stray that "survives" every kill: its /proc entry stays, as a process that keeps
    // forking would.
    const proc = await fakeProc({ 1: 0, 4999990: 1, 4999991: 1 });
    await expect(reapStrays(4999990, proc)).rejects.toThrow(/would not stop/);
  });

  it('does not count a killed process waiting for init (a zombie) as a survivor', async () => {
    const proc = await fakeProc({ 1: 0, 4999990: 1, 4999991: [1, 'Z'] });
    await expect(reapStrays(4999990, proc)).resolves.toBeUndefined();
  });
});
