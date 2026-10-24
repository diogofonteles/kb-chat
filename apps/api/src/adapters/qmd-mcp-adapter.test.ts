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
    expect(logs[0]).toMatch(/restarting/);
    expect(adapter.status()).toBe('ok');
  });

  it('fails to start when the command does not exist', async () => {
    adapter = new QmdMcpAdapter({ command: '/nonexistent/qmd' });
    await expect(adapter.start()).rejects.toThrow();
    expect(adapter.status()).toBe('down');
  });
});
