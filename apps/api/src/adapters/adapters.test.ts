import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAKES_DIR, FIXTURE_VAULT } from '../../test/fixture-paths.js';
import type { IndexHit, SearchIndexPort } from '../ports/search-index.js';
import { FixtureSearchAdapter } from './fixture-search-adapter.js';
import { FsVaultAdapter } from './fs-vault-adapter.js';
import { KbCliSearchAdapter } from './kb-cli-search-adapter.js';
import { ResilientSearchIndex } from './resilient-search-index.js';
import { toTopicRelativeId, toTypedSearches } from './search-mode-queries.js';

const query = {
  collection: 'hermetismo',
  q: 'ritmo',
  mode: 'all',
  limit: 5,
} as const;

class FakeIndex implements SearchIndexPort {
  constructor(
    private readonly state: 'ok' | 'down',
    private readonly hits: readonly IndexHit[] | Error,
  ) {}
  status(): 'ok' | 'down' {
    return this.state;
  }
  async search(): Promise<readonly IndexHit[]> {
    if (this.hits instanceof Error) throw this.hits;
    return this.hits;
  }
  async close(): Promise<void> {
    // nothing
  }
}

describe('search mode queries', () => {
  it('maps UI modes to typed QMD sub-queries', () => {
    expect(toTypedSearches('exact', 'x')).toEqual([
      { type: 'lex', query: 'x' },
    ]);
    expect(toTypedSearches('semantic', 'x')).toEqual([
      { type: 'vec', query: 'x' },
    ]);
    expect(toTypedSearches('all', 'x').map((s) => s.type)).toEqual([
      'lex',
      'vec',
    ]);
  });

  it('strips the scheme and collection from QMD paths', () => {
    expect(toTopicRelativeId('qmd://hermetismo/raw/a.md', 'hermetismo')).toBe(
      'raw/a.md',
    );
    expect(toTopicRelativeId('other/raw/a.md', 'hermetismo')).toBe(
      'other/raw/a.md',
    );
  });
});

describe('FsVaultAdapter', () => {
  const vault = new FsVaultAdapter(FIXTURE_VAULT);

  it('finds topics with topic.yaml and skips underscore folders', async () => {
    expect((await vault.listTopics()).map((t) => t.slug)).toEqual([
      'alquimia',
      'hermetismo',
    ]);
  });

  it('lists raw and wiki concept documents but not quarantine', async () => {
    const ids = await vault.listDocuments('hermetismo');
    expect(ids).toContain('wiki/concepts/Cabala.md');
    expect(ids.some((id) => id.includes('_quarantine'))).toBe(false);
  });

  it('returns null for a file that escapes the topic through a symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kbchat-'));
    const outside = join(root, 'secret.md');
    await writeFile(outside, 'secret');
    const topicDir = join(root, 't');
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(join(topicDir, 'raw'), { recursive: true }),
    );
    await writeFile(join(topicDir, 'topic.yaml'), 'title: T\n');
    await symlink(outside, join(topicDir, 'raw', 'link.md'));
    const reader = new FsVaultAdapter(root);
    expect(await reader.readDocument('t', 'raw/link.md')).toBeNull();
    expect(await reader.readDocument('t', 'raw/missing.md')).toBeNull();
    expect((await reader.listTopics())[0]).toEqual({ slug: 't', title: 'T' });
  });

  it('finds nested topics and falls back to the slug as title', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kbchat-'));
    const fs = await import('node:fs/promises');
    await fs.mkdir(join(root, 'harness', 'goclaw'), { recursive: true });
    await writeFile(
      join(root, 'harness', 'goclaw', 'topic.yaml'),
      'slug: goclaw\n',
    );
    expect(await new FsVaultAdapter(root).listTopics()).toEqual([
      { slug: 'harness/goclaw', title: 'harness/goclaw' },
    ]);
  });
});

describe('FixtureSearchAdapter', () => {
  const adapter = new FixtureSearchAdapter(
    new FsVaultAdapter(FIXTURE_VAULT),
    () => 'hermetismo',
  );

  it('requires every token in exact mode', async () => {
    const hits = await adapter.search({
      ...query,
      q: 'sétupla pitagóricos',
      mode: 'exact',
    });
    expect(hits).toEqual([]);
  });

  it('matches any token, accent-insensitive, in the other modes', async () => {
    const hits = await adapter.search({
      ...query,
      q: 'setupla pitagoricos',
      mode: 'semantic',
    });
    expect(hits.map((h) => h.id)).toEqual(
      expect.arrayContaining([
        'raw/articles/a-lei-do-ritmo.md',
        'raw/articles/a-natureza-s-tupla-2.md',
      ]),
    );
    expect(adapter.status()).toBe('ok');
  });

  it('returns nothing for a query without meaningful tokens', async () => {
    expect(await adapter.search({ ...query, q: 'a e' })).toEqual([]);
  });
});

describe('KbCliSearchAdapter', () => {
  const adapter = new KbCliSearchAdapter({
    command: join(FAKES_DIR, 'fake-kb.mjs'),
    vault: '/vault',
  });

  it('runs kb search with mode flags and maps the JSON hits', async () => {
    const [hit] = await adapter.search({ ...query, mode: 'semantic' });
    expect(hit?.id).toBe('raw/articles/a-lei-do-ritmo.md');
    expect(hit?.snippet).toContain('--vec');
    expect(hit?.snippet).toContain('--vault /vault');
    expect(adapter.status()).toBe('degraded');
  });

  it('rejects when kb exits with an error', async () => {
    await expect(adapter.search({ ...query, q: 'fail' })).rejects.toThrow();
  });
});

describe('ResilientSearchIndex', () => {
  const hit = { id: 'a.md', score: 1, snippet: '' };
  const backup = { id: 'b.md', score: 1, snippet: '' };

  it('uses the primary while it is up', async () => {
    const index = new ResilientSearchIndex(
      new FakeIndex('ok', [hit]),
      new FakeIndex('ok', [backup]),
    );
    expect(await index.search(query)).toEqual([hit]);
    expect(index.status()).toBe('ok');
  });

  it('falls back when the primary is down or throws', async () => {
    const down = new ResilientSearchIndex(
      new FakeIndex('down', [hit]),
      new FakeIndex('ok', [backup]),
    );
    expect(await down.search(query)).toEqual([backup]);
    expect(down.status()).toBe('degraded');
    const failing = new ResilientSearchIndex(
      new FakeIndex('ok', new Error('x')),
      new FakeIndex('ok', [backup]),
    );
    expect(await failing.search(query)).toEqual([backup]);
    await failing.close();
  });
});
