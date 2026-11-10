import { describe, expect, it } from 'vitest';
import {
  MemoryVault,
  memoryDoc,
  memoryTools,
} from '../../../test/memory-research.js';
import type { ToolCall } from '../../ports/llm.js';
import { SourceBook } from './source-book.js';
import { OPEN_VIEW } from '../access-levels/index.js';

const AUTHOR = 'José Laércio do Egito';

/** 13 lectures of the author (Temas-docs), 12 books of others, 5 other Temas-docs texts. */
function corpus(): Record<string, string> {
  const docs: Record<string, string> = {};
  for (let i = 1; i <= 25; i += 1) {
    const byAuthor = i % 2 === 1;
    docs[`raw/articles/v${i}.md`] = memoryDoc({
      title: `Texto ${i}`,
      body: 'A vibração.',
      entities: byAuthor ? [AUTHOR, 'Rosacruz'] : ['Helena Blavatsky'],
      sourcePath: byAuthor
        ? `_convert/Temas-docs/TEMA ${i}.txt`
        : `_convert/ready/dropbox/Livros/Livro ${i}.txt`,
    });
  }
  for (let i = 1; i <= 5; i += 1)
    docs[`raw/articles/outro-${i}.md`] = memoryDoc({
      title: `Outro ${i}`,
      body: 'Nada.',
      entities: [
        'Temas Herméticos', // A YAML name with a line break inside it.
        `"Linha 1\\nLinha 2 ${i}"`,
      ],
      sourcePath: `_convert/Temas-docs/OUTRO ${i}.txt`,
    });
  docs['raw/articles/miasmas.md'] = memoryDoc({
    title: 'Miasmas',
    body: 'Os miasmas.',
    entities: [AUTHOR],
    sourcePath: '_convert/ready/dropbox/JOSÉ LAÉRCIO DO EGITO/Miasmas.txt',
  });
  return docs;
}

const call = (args: object): ToolCall => ({
  id: 'c1',
  name: 'list_sources',
  arguments: JSON.stringify(args),
});

async function run(args: object) {
  const tools = await memoryTools(new MemoryVault(corpus()));
  const prepared = tools.prepare(call(args), {
    topic: 'hermetismo',
    book: new SourceBook(),
    view: OPEN_VIEW,
  });
  return { steps: prepared.steps, output: await prepared.run() };
}

describe('list_sources (KBC-017 AC-6)', () => {
  it('lists origin folders and entities with counts, filtered by a fragment', async () => {
    const { steps, output } = await run({ query: 'temas' });
    expect(steps).toEqual([
      {
        kind: 'subjects',
        text: 'Listando as origens e entidades sobre “temas”',
      },
    ]);
    expect(output).toContain('Origens (1 de 1):');
    expect(output).toContain('- Temas-docs (18 documento(s))');
    expect(output).toContain('Entidades (1 de 1):');
    expect(output).toContain('- Temas Herméticos (5 documento(s))');
    const authors = await run({ kind: 'entities' });
    expect(authors.output.split('\n')[2]).toBe(`- ${AUTHOR} (14 documento(s))`);
    expect(authors.output).not.toContain('Origens');
  });

  it('pages each list and keeps every name on one line', async () => {
    const { output } = await run({ kind: 'entities', head_limit: 2 });
    expect(output.split('\n')[1]).toBe(
      'Entidades (2 de 9): Mostrando 1–2 de 9.',
    );
    expect(output).toContain('Próxima página: offset=2.');
    const next = await run({ kind: 'entities', query: 'linha', offset: 4 });
    expect(next.output).toContain('- Linha 1 Linha 2 5 (1 documento(s))');
    expect(next.output).toContain('Fim da lista.');
    const none = await run({ kind: 'sources', query: 'xyz' });
    expect(none.output.split('\n').slice(1)).toEqual(['Origens: nenhuma.']);
  });

  it('keeps the output within the page budget with very long names (NFR-3)', async () => {
    const docs: Record<string, string> = {};
    for (let i = 1; i <= 250; i += 1)
      docs[`raw/articles/l-${i}.md`] = memoryDoc({
        title: `L ${i}`,
        body: 'x',
        entities: [`${'Entidade de nome muito longo '.repeat(6)}${i}`],
        sourcePath: `_convert/${'Pasta de origem muito longa/'.repeat(10)}${i}/x.txt`,
      });
    const tools = await memoryTools(new MemoryVault(docs));
    const output = await tools
      .prepare(call({ head_limit: 200 }), {
        topic: 'hermetismo',
        book: new SourceBook(),
        view: OPEN_VIEW,
      })
      .run();
    expect(output.length).toBeLessThan(60_000);
    expect(output).toMatch(/Próxima página: offset=\d+\./);
  });
});
