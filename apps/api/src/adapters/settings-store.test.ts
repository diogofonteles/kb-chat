import {
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventQueue } from './event-queue.js';
import { JsonSettingsStore, settingsFileName } from './json-settings-store.js';
import { MemorySettingsStore } from './memory-settings-store.js';

describe('JsonSettingsStore', () => {
  it('keeps one 0600 file per principal and reads null before the first save', async () => {
    const folder = join(
      await mkdtemp(join(tmpdir(), 'kbchat-store-')),
      'settings',
    );
    const store = new JsonSettingsStore(folder);
    expect(await store.read('owner')).toBeNull();
    await store.write('owner', { a: 1 });
    await store.write('ana@example.com', { b: 2 });
    expect(await store.read('owner')).toEqual({ a: 1 });
    expect(await store.read('ana@example.com')).toEqual({ b: 2 });
    const files = await readdir(folder);
    expect(files).toHaveLength(2);
    expect(files).toContain('owner.json');
    expect((await stat(join(folder, 'owner.json'))).mode & 0o777).toBe(0o600);
  });

  it('hashes principal ids that are not plain file names', () => {
    expect(settingsFileName('owner')).toBe('owner.json');
    expect(settingsFileName('../etc/passwd')).toMatch(/^[0-9a-f]{32}\.json$/);
  });

  it('leaves no temporary file behind when the write fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kbchat-store-'));
    // The target is a folder, so the rename fails after the temporary file was written.
    await mkdir(join(root, 'owner.json'));
    await expect(
      new JsonSettingsStore(root).write('owner', {}),
    ).rejects.toThrow();
    expect(await readdir(root)).toEqual(['owner.json']);
  });

  it('surfaces unreadable files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kbchat-store-'));
    await writeFile(join(root, 'owner.json'), '{not json');
    await expect(new JsonSettingsStore(root).read('owner')).rejects.toThrow();
    expect(await readFile(join(root, 'owner.json'), 'utf8')).toBe('{not json');
  });
});

describe('MemorySettingsStore', () => {
  it('copies values in and out per principal', async () => {
    const store = new MemorySettingsStore();
    const value = { a: 1 };
    await store.write('owner', value);
    value.a = 2;
    expect(await store.read('owner')).toEqual({ a: 1 });
    expect(await store.read('other')).toBeNull();
  });
});

describe('EventQueue', () => {
  it('yields pushed items in order and ends once drained', async () => {
    const queue = new EventQueue<number>();
    queue.push(1);
    setTimeout(() => {
      queue.push(2);
      queue.end();
      queue.push(3);
    }, 5);
    const out: number[] = [];
    for await (const item of queue) out.push(item);
    expect(out).toEqual([1, 2]);
  });
});
