import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKES_DIR, FIXTURE_VAULT } from '../test/fixture-paths.js';
import { FsVaultAdapter } from './adapters/fs-vault-adapter.js';
import { QmdMcpAdapter } from './adapters/qmd-mcp-adapter.js';
import { IndexReloadWatcher } from './index-reload.js';
import { CatalogRegistry } from './modules/catalog/index.js';

const fakeQmd = join(FAKES_DIR, 'fake-qmd.mjs');
const query = (q: string) =>
  ({ collection: 'hermetismo', q, mode: 'all', limit: 5 }) as const;

const silent = { info: () => undefined, error: () => undefined };

let adapter: QmdMcpAdapter | undefined;
let watcher: IndexReloadWatcher | undefined;
afterEach(async () => {
  await watcher?.stop();
  await adapter?.close();
});

const pidOf = async (one: QmdMcpAdapter) =>
  (await one.search(query('pid')))[0]?.snippet;

/** A track document as the Mac's sync leaves it in production's vault. */
const TRACK = `---
title: Faixa nova
type: source
kb_chat_media_id: 0b9c1f7e-1111-4a2b-8c3d-000000000001
kb_chat_media_kind: track
kb_chat_recording_id: 0b9c1f7e-1111-4a2b-8c3d-000000000002
kb_chat_fingerprint: ${'f'.repeat(64)}
---

# Faixa nova
`;

describe('Hot swap of the search index (KBC-100 FR-5, AC-13, NFR-2)', () => {
  it('a new qmd mcp takes the next searches; one in flight finishes on the old one', async () => {
    adapter = new QmdMcpAdapter({ command: process.execPath, args: [fakeQmd] });
    await adapter.start();
    const before = await pidOf(adapter);

    const long = adapter.search(query('slow'));
    await adapter.reload();
    const after = await pidOf(adapter);

    await expect(long).resolves.toHaveLength(1);
    expect(after).not.toBe(before);
    expect(adapter.status()).toBe('ok');
  });

  it('NFR-2: ten swaps with a long search running interrupt none and never leave search down', async () => {
    adapter = new QmdMcpAdapter({ command: process.execPath, args: [fakeQmd] });
    await adapter.start();
    const running: Promise<unknown>[] = [];
    for (let swap = 0; swap < 10; swap += 1) {
      running.push(adapter.search(query('slow')));
      const reloading = adapter.reload();
      expect(adapter.status()).toBe('ok');
      await reloading;
    }
    const results = await Promise.allSettled(running);
    expect(results.filter((one) => one.status === 'rejected')).toEqual([]);
  });

  it('a new process that does not start leaves the old one serving', async () => {
    adapter = new QmdMcpAdapter({ command: process.execPath, args: [fakeQmd] });
    await adapter.start();
    const broken = adapter as unknown as { options: { args: string[] } };
    const before = await pidOf(adapter);
    broken.options.args = ['/nowhere/qmd.mjs'];
    await expect(adapter.reload()).rejects.toThrow();
    expect(await pidOf(adapter)).toBe(before);
  });

  it('AC-13: the trigger reloads the index and the catalog, which sees the new document, and acks', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'kbchat-vault-'));
    await cp(FIXTURE_VAULT, vault, { recursive: true });
    const catalog = new CatalogRegistry(new FsVaultAdapter(vault));
    await catalog.load();
    const seen: string[] = [];
    catalog.onReload(() =>
      seen.push(
        String(
          catalog
            .get('hermetismo')
            ?.entries.get('raw/media/r/t.md')
            ?.media?.fingerprint.slice(0, 4),
        ),
      ),
    );
    adapter = new QmdMcpAdapter({ command: process.execPath, args: [fakeQmd] });
    await adapter.start();
    const before = await pidOf(adapter);
    const state = await mkdtemp(join(tmpdir(), 'kbchat-qmd-'));
    const trigger = join(state, 'reload-index');
    const current = adapter;
    watcher = new IndexReloadWatcher({
      trigger,
      reloadIndex: () => current.reload(),
      reloadCatalog: () => catalog.load(),
      log: silent,
      pollMs: 20,
    });
    await watcher.start();

    // sync-vault.sh sends the vault, then install-index.sh --hot writes the trigger.
    await mkdir(join(vault, 'hermetismo', 'raw', 'media', 'r'), {
      recursive: true,
    });
    await writeFile(
      join(vault, 'hermetismo', 'raw', 'media', 'r', 't.md'),
      TRACK,
    );
    const long = adapter.search(query('slow'));
    await writeFile(trigger, 'index-20261107140200.sqlite\n');

    await expect
      .poll(() => readFile(`${trigger}.ack`, 'utf8').catch(() => ''), {
        timeout: 5_000,
      })
      .toBe('index-20261107140200.sqlite\n');
    await expect(long).resolves.toHaveLength(1);
    expect(await pidOf(adapter)).not.toBe(before);
    expect(seen.at(-1)).toBe('ffff');
  });

  it('a trigger already there at start is the index the API opened: nothing is reloaded', async () => {
    const state = await mkdtemp(join(tmpdir(), 'kbchat-qmd-'));
    const trigger = join(state, 'reload-index');
    await writeFile(trigger, 'index-old.sqlite\n');
    let reloads = 0;
    watcher = new IndexReloadWatcher({
      trigger,
      reloadIndex: async () => {
        reloads += 1;
      },
      reloadCatalog: async () => undefined,
      log: silent,
      pollMs: 20,
    });
    await watcher.start();
    await watcher.check();
    expect(reloads).toBe(0);
  });
});
