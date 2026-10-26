import { describe, expect, it } from 'vitest';
import {
  FixedIndex,
  MemoryVault,
  memoryDoc,
  memoryTools,
} from '../../../test/memory-research.js';
import type { ToolCall } from '../../ports/llm.js';
import { SourceBook } from './source-book.js';
import type { ResearchTools, ToolContext } from './tools.js';

const AUTHOR = 'José Laércio do Egito';
const BIG_ID = 'raw/articles/miasmas.md';

/**
 * 25 documents that say "vibração" (document i says it i times), 5 that do not, and a
 * compilation of more than 100,000 characters with 40 "livro" and 3 "obra" spread out.
 */
function corpus(): Record<string, string> {
  const docs: Record<string, string> = {};
  for (let i = 1; i <= 25; i += 1) {
    const byAuthor = i % 2 === 1;
    docs[`raw/articles/v${String(i).padStart(2, '0')}.md`] = memoryDoc({
      title: `Vibração ${String(i).padStart(2, '0')}`,
      body: `Texto ${i}. ${'A vibração do som. '.repeat(i)}Fim.`,
      entities: byAuthor ? [AUTHOR, 'Rosacruz'] : ['Helena Blavatsky'],
      sourcePath: byAuthor
        ? `_convert/Temas-docs/TEMA ${i}.txt`
        : `_convert/ready/dropbox/Livros/Livro ${i}.txt`,
    });
  }
  for (let i = 1; i <= 5; i += 1)
    docs[`raw/articles/outro-${i}.md`] = memoryDoc({
      title: `Outro ${i}`,
      body: 'Nada sobre isso.',
      entities: ['Temas Herméticos'],
      sourcePath: `_convert/Temas-docs/OUTRO ${i}.txt`,
    });
  docs[BIG_ID] = memoryDoc({
    title: 'Homeopatia – Teoria Miasmática',
    body: bigBody(),
    entities: [AUTHOR],
    sourcePath: '_convert/ready/dropbox/JOSÉ LAÉRCIO DO EGITO/Miasmas.txt',
  });
  return docs;
}

/** About 150,000 characters: 40 paragraphs, each with one "livro"; 3 also cite an "obra". */
function bigBody(): string {
  const filler = 'Os miasmas e a energia vital do organismo. '.repeat(80);
  return Array.from(
    { length: 40 },
    (_, i) =>
      `${filler}\n\nVer o livro número ${i + 1}${i % 13 === 1 ? ' e a obra citada' : ''}.\n\n`,
  ).join('');
}

const call = (name: string, args: object): ToolCall => ({
  id: 'c1',
  name,
  arguments: JSON.stringify(args),
});

const context = (): ToolContext => ({
  topic: 'hermetismo',
  book: new SourceBook(),
});

async function run(tools: ResearchTools, ctx: ToolContext, toolCall: ToolCall) {
  const prepared = tools.prepare(toolCall, ctx);
  return { steps: prepared.steps, output: await prepared.run() };
}

const listed = (output: string): string[] =>
  output.split('\n').filter((line) => /^\[\d+\] /.test(line));

describe('find_text as a grep (KBC-017, ADR 0013)', () => {
  it('reports every matching document and pages to the end (AC-1)', async () => {
    const tools = await memoryTools(new MemoryVault(corpus()));
    const ctx = context();
    const first = await run(
      tools,
      ctx,
      call('find_text', { phrase: 'vibração', head_limit: 10 }),
    );
    expect(first.output.split('\n')[0]).toMatch(
      /^Texto “vibração”: 25 documento\(s\), 325 ocorrência\(s\), em 31 documentos varridos\. Mostrando 1–10 de 25\.$/,
    );
    expect(listed(first.output)).toHaveLength(10);
    expect(listed(first.output)[0]).toMatch(
      /^\[1\] Vibração 25 · 25 ocorrência\(s\) · origem: Temas-docs/,
    );
    expect(first.output).toMatch(/Próxima página: offset=10\.?$/m);
    const last = await run(
      tools,
      ctx,
      call('find_text', { phrase: 'vibração', head_limit: 10, offset: 20 }),
    );
    expect(listed(last.output)).toHaveLength(5);
    expect(last.output).toContain('Mostrando 21–25 de 25.');
    expect(last.output.trimEnd().endsWith('Fim da lista.')).toBe(true);
    // Documents are numbered as they first show up: the skipped page was never listed.
    expect(listed(last.output)[0]).toMatch(/^\[11\] Vibração 05 /);
  });

  it('gives a passage only on the first lines of a page in files mode', async () => {
    const tools = await memoryTools(new MemoryVault(corpus()));
    const { output } = await run(
      tools,
      context(),
      call('find_text', { phrase: 'vibração' }),
    );
    const lines = listed(output);
    expect(lines).toHaveLength(25);
    expect(lines.filter((line) => line.includes('Trecho:'))).toHaveLength(3);
  });

  it('counts occurrences per document without passages (AC-2)', async () => {
    const tools = await memoryTools(new MemoryVault(corpus()));
    const { output } = await run(
      tools,
      context(),
      call('find_text', { phrase: 'vibração', output_mode: 'count' }),
    );
    expect(listed(output)).toHaveLength(25);
    expect(output).not.toContain('Trecho:');
    expect(listed(output)[24]).toMatch(/^\[25\] Vibração 01 · 1$/);
  });

  it('lists every document of an entity without a phrase (AC-3)', async () => {
    const tools = await memoryTools(new MemoryVault(corpus()));
    const { steps, output } = await run(
      tools,
      context(),
      call('find_text', { entity: 'jose laercio' }),
    );
    expect(steps[0]?.text).toBe(
      'Listando os documentos de entidade “jose laercio”',
    );
    expect(output.split('\n')[0]).toMatch(
      /^Documentos com entidade “jose laercio”: 14 documento\(s\)\. Mostrando 1–14 de 14\.$/,
    );
    expect(listed(output)).toHaveLength(14);
    expect(output).not.toContain('Vibração 02');
  });

  it('filters by origin folder and leaves out excluded documents (AC-4)', async () => {
    const tools = await memoryTools(new MemoryVault(corpus()));
    const ctx = context();
    await run(tools, ctx, call('find_text', { phrase: 'vibração' }));
    const second = ctx.book.find(2)?.title;
    expect(second).toBe('Vibração 24');
    const third = ctx.book.find(3)?.title;
    const { output } = await run(
      tools,
      ctx,
      call('find_text', {
        phrase: 'vibração',
        source: 'temas-DOCS',
        exclude: ['[3]', 'Blavatsky'],
      }),
    );
    expect(output.split('\n')[0]).toMatch(/: 12 documento\(s\)/);
    expect(output).toContain('origem contém “temas-DOCS”');
    expect(output).not.toContain(`] ${third} ·`);
    expect(listed(output).every((line) => line.includes('Temas-docs'))).toBe(
      true,
    );
  });

  it('greps one whole document, paged, with positions read_document understands (AC-5)', async () => {
    const tools = await memoryTools(new MemoryVault(corpus()));
    const ctx = context();
    const { steps, output } = await run(
      tools,
      ctx,
      call('find_text', {
        document: BIG_ID,
        phrase: 'livro | obra',
        output_mode: 'content',
        head_limit: 30,
      }),
    );
    expect(steps[0]?.text).toBe(
      'Procurando “livro | obra” em “Homeopatia – Teoria Miasmática” inteiro',
    );
    expect(output.split('\n')[0]).toMatch(
      /^Texto “livro” ou “obra” em \[1\] Homeopatia – Teoria Miasmática \(\d{6} caracteres\): 43 ocorrência\(s\)\. Mostrando 1–30 de 43\.$/,
    );
    const hits = output.split('\n').filter((line) => /^- @\d+/.test(line));
    expect(hits).toHaveLength(30);
    expect(output).toMatch(/Próxima página: offset=30/);
    const position = Number(/^- @(\d+)/.exec(hits[1] ?? '')?.[1]);
    const read = await run(
      tools,
      ctx,
      call('read_document', { document: 1, offset: position, limit: 1000 }),
    );
    expect(read.output).toMatch(/<<<DOCUMENTO\nlivro número 2 e a obra/);
    expect(output.length).toBeLessThan(60_000);
  });

  it('pages content across documents in rank order', async () => {
    const tools = await memoryTools(new MemoryVault(corpus()));
    const { output } = await run(
      tools,
      context(),
      call('find_text', {
        phrase: 'vibração',
        output_mode: 'content',
        head_limit: 30,
        offset: 20,
      }),
    );
    expect(output.split('\n')[0]).toContain('Mostrando 21–50 de 325.');
    // The first document has 25 occurrences: the page starts at its 21st.
    expect(output).toMatch(/^\[1\] Vibração 25: ocorrências 21–25 de 25$/m);
    expect(output).toMatch(/^\[2\] Vibração 24: ocorrências 1–24 de 24$/m);
    expect(output).toMatch(/^\[3\] Vibração 23: ocorrência 1 de 23$/m);
  });

  it('refuses a document grep without a phrase and an empty request', async () => {
    const tools = await memoryTools(new MemoryVault(corpus()));
    const ctx = context();
    const noPhrase = await run(
      tools,
      ctx,
      call('find_text', { document: BIG_ID }),
    );
    expect(noPhrase.steps).toEqual([]);
    expect(noPhrase.output).toMatch(/^Argumentos inválidos .*phrase/);
    const empty = await run(tools, ctx, call('find_text', {}));
    expect(empty.output).toMatch(/^Argumentos inválidos .*entity/);
  });
});

describe('list_sources (KBC-017 AC-6)', () => {
  it('lists origin folders and entities with counts, filtered by a fragment', async () => {
    const tools = await memoryTools(new MemoryVault(corpus()));
    const { steps, output } = await run(
      tools,
      context(),
      call('list_sources', { query: 'temas' }),
    );
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
    const authors = await run(
      tools,
      context(),
      call('list_sources', { kind: 'entities' }),
    );
    expect(authors.output.split('\n')[1]).toBe(`- ${AUTHOR} (14 documento(s))`);
    expect(authors.output).not.toContain('Origens');
  });
});

describe('read_document paging (KBC-017 AC-7)', () => {
  it('reads a page of the asked size and tells the next offset', async () => {
    const tools = await memoryTools(new MemoryVault(corpus()));
    const { output } = await run(
      tools,
      context(),
      call('read_document', {
        document: BIG_ID,
        offset: 100_000,
        limit: 20_000,
      }),
    );
    expect(output).toMatch(/caracteres 100000 a 120000 de \d{6}:/);
    expect(output).toContain('offset=120000');
  });
});

describe('search_collection paging and filters (KBC-017 AC-8)', () => {
  it('keeps only the entity documents among the candidates, from the offset', async () => {
    const hits = Object.keys(corpus()).map((id, i) => ({
      id,
      score: 1 - i / 100,
      snippet: 'a vibração',
    }));
    const index = new FixedIndex(hits);
    const tools = await memoryTools(new MemoryVault(corpus()), index);
    const { output } = await run(
      tools,
      context(),
      call('search_collection', {
        query: 'vibração',
        entity: 'laercio',
        offset: 10,
        limit: 30,
      }),
    );
    expect(output.split('\n')[0]).toMatch(
      /^Busca “vibração” \(modo all; entidade contém “laercio”\): 11–14 de 14 documento\(s\) entre 31 candidatos da busca por sentido\./,
    );
    expect(listed(output)).toHaveLength(4);
    expect(output).not.toContain('Blavatsky');
  });
});
