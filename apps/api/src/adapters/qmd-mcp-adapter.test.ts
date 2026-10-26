import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKES_DIR } from '../../test/fixture-paths.js';
import { QmdMcpAdapter } from './qmd-mcp-adapter.js';

const fakeQmd = join(FAKES_DIR, 'fake-qmd.mjs');
const query = {
  collection: 'hermetismo',
  q: 'ritmo',
  mode: 'all',
  limit: 5,
} as const;
const waitFor = async (check: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

let adapter: QmdMcpAdapter | undefined;
afterEach(async () => {
  await adapter?.close();
});

describe('QmdMcpAdapter', () => {
  it('sends typed sub-queries without reranking and maps hits to topic ids', async () => {
    adapter = new QmdMcpAdapter({ command: process.execPath, args: [fakeQmd] });
    await adapter.start();
    expect(adapter.status()).toBe('ok');
    const hits = await adapter.search(query);
    expect(hits).toEqual([
      {
        id: 'raw/articles/a-lei-do-ritmo.md',
        score: 0.9,
        snippet: '12: lex+vec ritmo',
      },
    ]);
  });

  it('is down before start and refuses to search', async () => {
    adapter = new QmdMcpAdapter({ command: process.execPath, args: [fakeQmd] });
    expect(adapter.status()).toBe('down');
    await expect(adapter.search(query)).rejects.toThrow(/not connected/);
  });

  it('restarts the process after it dies', async () => {
    const logs: string[] = [];
    adapter = new QmdMcpAdapter({
      command: process.execPath,
      args: [fakeQmd],
      backoffMs: [10],
      onLog: (message) => logs.push(message),
    });
    await adapter.start();
    await expect(adapter.search({ ...query, q: 'crash' })).rejects.toThrow();
    await waitFor(() => logs.length > 0 && adapter?.status() === 'ok');
    expect(logs[0]).toMatch(/retrying/);
    expect(adapter.status()).toBe('ok');
  });

  it('fails to start when the command does not exist', async () => {
    adapter = new QmdMcpAdapter({
      command: '/nonexistent/qmd',
      backoffMs: [60_000],
    });
    await expect(adapter.start()).rejects.toThrow();
    expect(adapter.status()).toBe('down');
  });

  it('retries a process that keeps dying linearly and stops after close', async () => {
    const logs: string[] = [];
    adapter = new QmdMcpAdapter({
      command: process.execPath,
      args: [join(FAKES_DIR, 'fake-qmd-exit.mjs')],
      backoffMs: [20],
      onLog: (message) => logs.push(message),
    });
    await expect(adapter.start()).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 400));
    // One retry per backoff period (≈ 400 / (20 + spawn time)), never exponential.
    expect(logs.length).toBeGreaterThan(1);
    expect(logs.length).toBeLessThan(25);
    await adapter.close();
    const afterClose = logs.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(logs.length).toBe(afterClose);
  });

  it('warms the collection up with one lexical and one vector query after connecting', async () => {
    const logFile = join(
      await mkdtemp(join(tmpdir(), 'kbchat-qmd-')),
      'queries.jsonl',
    );
    adapter = new QmdMcpAdapter({
      command: process.execPath,
      args: [fakeQmd, logFile],
      warmCollection: 'hermetismo',
    });
    await adapter.start();
    const readTypes = async (): Promise<string[]> =>
      (await readFile(logFile, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).searches[0].type);
    let types: string[] = [];
    for (let attempt = 0; attempt < 100 && types.length < 2; attempt += 1) {
      types = await readTypes();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(types).toEqual(['lex', 'vec']);
  });

  it('does not keep a process alive when closed during a reconnect', async () => {
    adapter = new QmdMcpAdapter({ command: process.execPath, args: [fakeQmd] });
    const starting = adapter.start();
    await adapter.close();
    await starting;
    expect(adapter.status()).toBe('down');
  });
});
