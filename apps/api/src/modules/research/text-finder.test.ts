import { describe, expect, it } from 'vitest';
import type { TopicFolder, VaultReaderPort } from '../../ports/vault-reader.js';
import { CatalogRegistry, splitFrontmatter } from '../catalog/index.js';
import { flatText, foldText } from './folded-text.js';
import { TextFinder } from './text-finder.js';

interface FindQuery {
  readonly topic: string;
  readonly phrases: readonly string[];
  readonly limit: number;
}

/** The ranked documents with their passages, as find_text's files mode shows them. */
async function find(finder: TextFinder, query: FindQuery) {
  const counted = await finder.count({ ...query, accept: () => true });
  if (!counted) return null;
  const hits = await Promise.all(
    counted.matches.slice(0, query.limit).map(async (match) => ({
      ...match,
      snippet: await finder.snippet(query.topic, match),
    })),
  );
  return {
    hits,
    documents: counted.matches.length,
    occurrences: counted.occurrences,
    scanned: counted.scanned,
  };
}

/** An in-memory vault with one topic whose documents can be swapped between loads. */
class MemoryVault implements VaultReaderPort {
  reads = 0;

  constructor(public docs: Record<string, string>) {}

  async listTopics(): Promise<readonly TopicFolder[]> {
    return [{ slug: 'hermetismo', title: 'Hermetismo' }];
  }

  async listDocuments(): Promise<readonly string[]> {
    return Object.keys(this.docs);
  }

  async readDocument(_topic: string, id: string): Promise<string | null> {
    this.reads += 1;
    return this.docs[id] ?? null;
  }
}

const doc = (title: string, body: string, summary = 'Um texto.'): string =>
  `---\ntitle: ${title}\nsummary: ${summary}\n---\n\n${body}\n`;

const DOCS = {
  'raw/articles/espaco-tempo.md': doc(
    'A Setuplicidade do Espaço-Tempo',
    'Sobre o tempo.\n\nTudo depende dos **Cinco Princípios\nUniversais** (descontinuidade – limite – movimento – espaço – tempo).',
  ),
  'raw/articles/principios.md': doc(
    'Os Princípios Herméticos',
    'Há cinco princípios velados. Os cinco princípios velados não são revelados; os CINCO PRINCÍPIOS VELADOS são descobertos.',
    'Fala dos cinco princípios universais.',
  ),
  'raw/articles/receita.md': doc('Torta', 'Nada a ver com princípio algum.'),
};

async function finderOver(vault: MemoryVault) {
  const catalog = new CatalogRegistry(vault);
  await catalog.load();
  return { catalog, finder: new TextFinder({ catalog, vault }) };
}

describe('foldText', () => {
  it('folds accents, case and typographic marks keeping the length', () => {
    const flat = flatText('Os “Cinco”\n  PRINCÍPIOS — Ação');
    expect(flat).toBe('Os “Cinco” PRINCÍPIOS — Ação');
    expect(foldText(flat)).toBe('os "cinco" principios - acao');
    expect(foldText(flat)).toHaveLength(flat.length);
  });
});

describe('TextFinder', () => {
  it('finds a phrase across line breaks and bold marks, in a document about another theme', async () => {
    const { finder } = await finderOver(new MemoryVault({ ...DOCS }));
    const found = await find(finder, {
      topic: 'hermetismo',
      phrases: ['cinco principios universais'],
      limit: 10,
    });
    expect(found).toMatchObject({ documents: 2, occurrences: 2, scanned: 3 });
    const espaco = found?.hits.find((h) => h.entry.id.includes('espaco'));
    expect(espaco?.snippet).toContain(
      'Cinco Princípios Universais (descontinuidade – limite – movimento – espaço – tempo)',
    );
  });

  it('leans the passage forward, so a list that follows its phrase shows in it (KBC-011)', async () => {
    const lead = 'Antes. '.repeat(40);
    const gap = 'x'.repeat(220);
    const { finder } = await finderOver(
      new MemoryVault({
        'raw/articles/longo.md': doc(
          'Longo',
          `${lead}Os cinco princípios ocultos ${gap} são descontinuidade e limite.`,
        ),
      }),
    );
    const found = await find(finder, {
      topic: 'hermetismo',
      phrases: ['cinco principios ocultos'],
      limit: 10,
    });
    const snippet = found?.hits[0]?.snippet ?? '';
    expect(snippet).toContain('descontinuidade e limite');
    expect(snippet.indexOf('cinco princípios')).toBeLessThanOrEqual(125);
  });

  it('ranks documents by occurrences of any alternative and counts each one', async () => {
    const { finder } = await finderOver(new MemoryVault({ ...DOCS }));
    const found = await find(finder, {
      topic: 'hermetismo',
      phrases: [
        'princípios ocultos',
        'princípios velados',
        'princípios universais',
      ],
      limit: 1,
    });
    expect(found?.documents).toBe(2);
    expect(found?.hits).toHaveLength(1);
    expect(found?.hits[0]).toMatchObject({
      entry: { id: 'raw/articles/principios.md' },
      occurrences: 4,
      phrases: [
        { phrase: 'princípios velados', count: 3 },
        { phrase: 'princípios universais', count: 1 },
      ],
    });
    expect(found?.hits[0]?.snippet).toMatch(/^Fala dos cinco .*velados/);
  });

  it('returns no hits for an absent phrase and null for an unknown topic', async () => {
    const { finder } = await finderOver(new MemoryVault({ ...DOCS }));
    const none = await find(finder, {
      topic: 'hermetismo',
      phrases: ['doze princípios'],
      limit: 5,
    });
    expect(none).toEqual({
      hits: [],
      documents: 0,
      occurrences: 0,
      scanned: 3,
    });
    expect(
      await find(finder, { topic: 'nope', phrases: ['x'], limit: 5 }),
    ).toBeNull();
  });

  it('reads the vault once per catalog load and again after a reload', async () => {
    const vault = new MemoryVault({ ...DOCS });
    const { catalog, finder } = await finderOver(vault);
    const query = { topic: 'hermetismo', phrases: ['tortinha'], limit: 5 };
    await finder.warm('hermetismo');
    const afterWarm = vault.reads;
    await find(finder, query);
    expect(vault.reads).toBe(afterWarm);
    vault.docs = {
      ...DOCS,
      'raw/articles/nova.md': doc('Nova', 'Uma tortinha.'),
    };
    await catalog.load();
    const found = await find(finder, query);
    expect(found?.hits.map((h) => h.entry.title)).toEqual(['Nova']);
  });

  it('shows body occurrences with body text only, and summary ones as such (KBC-017)', async () => {
    const { catalog, finder } = await finderOver(
      new MemoryVault({
        'raw/articles/obra.md': doc(
          'Obra',
          'Livro citado logo no início.',
          'O resumo também cita um livro.',
        ),
      }),
    );
    const entry = catalog
      .get('hermetismo')
      ?.entries.get('raw/articles/obra.md');
    if (!entry) throw new Error('fixture missing');
    const found = await finder.occurrencesIn('hermetismo', entry, {
      phrases: ['livro'],
      chars: 120,
    });
    const body = splitFrontmatter(
      doc('Obra', 'Livro citado logo no início.', 'x'),
    ).body;
    // The offset is read_document's: the body as split from the frontmatter.
    expect(found?.items.map((i) => i.offset)).toEqual([
      null,
      body.indexOf('Livro'),
    ]);
    expect(found?.items[1]?.context).toMatch(/^…Livro citado/);
    expect(found?.items[0]?.context).toContain('resumo');
  });
});
