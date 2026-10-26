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

const MESTRE = 'José Laércio do Egito';

/**
 * 3 lectures of the Mestre, 2 books of other authors (one quotes him), 1 wiki synthesis
 * and 1 source the owner has not marked yet; every one says "vibração".
 */
function corpus(): Record<string, string> {
  const lecture = (i: number) =>
    memoryDoc({
      title: `Tema ${i}`,
      body: `A vibração ensinada no tema ${i}.`,
      entities: [MESTRE],
      sourcePath: `_convert/Temas-docs/TEMA ${i}.txt`,
      authorGroup: 'mestre-laercio',
      author: MESTRE,
    });
  return {
    'raw/articles/tema-1.md': lecture(1),
    'raw/articles/tema-2.md': lecture(2),
    'raw/articles/tema-3.md': lecture(3),
    'raw/articles/caibalion.md': memoryDoc({
      title: 'O Caibalion',
      body: 'Tudo é vibração, dizem os Três Iniciados.',
      entities: ['Três Iniciados'],
      sourcePath: '_convert/ready/dropbox/Livros/Caibalion.txt',
      authorGroup: 'outros-autores',
    }),
    'raw/articles/leitor.md': memoryDoc({
      title: 'Artigo de um leitor',
      body: `Como diz ${MESTRE}, a vibração é tudo.`,
      entities: [MESTRE],
      sourcePath: '_convert/Artigos dos Leitores/x.txt',
      authorGroup: 'outros-autores',
    }),
    'wiki/concepts/Vibração.md': memoryDoc({
      title: 'Vibração',
      body: 'Síntese: a vibração no acervo.',
    }),
    'raw/articles/novo.md': memoryDoc({
      title: 'Ingestão nova',
      body: 'Outra vibração.',
      sourcePath: '_convert/Temas-docs/NOVO.txt',
    }),
  };
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

async function run(
  tools: ResearchTools,
  toolCall: ToolCall,
  ctx: ToolContext = context(),
) {
  const prepared = tools.prepare(toolCall, ctx);
  return { steps: prepared.steps, output: await prepared.run() };
}

const listed = (output: string): string[] =>
  output.split('\n').filter((line) => /^\[\d+\] /.test(line));

describe('authorship in the research tools (KBC-020 AC-4, AC-5)', () => {
  it('labels every find_text line with the authorship of its document', async () => {
    const tools = await memoryTools(new MemoryVault(corpus()));
    const files = await run(tools, call('find_text', { phrase: 'vibração' }));
    const lines = listed(files.output);
    expect(lines).toHaveLength(7);
    expect(lines.every((line) => line.includes(' · autoria: '))).toBe(true);
    const labelOf = (title: string) =>
      lines
        .find((line) => line.includes(`] ${title} `))
        ?.match(/ · autoria: ([^·—]+?)(?: —|$| ·)/)?.[1];
    expect(labelOf('Tema 1')).toBe('Mestre Laércio');
    expect(labelOf('O Caibalion')).toBe('Outros autores');
    expect(labelOf('Vibração')).toBe('Síntese do acervo');
    expect(labelOf('Ingestão nova')).toBe('Não classificado');
    const count = await run(
      tools,
      call('find_text', { phrase: 'vibração', output_mode: 'count' }),
    );
    expect(
      listed(count.output).every((line) => line.includes(' · autoria: ')),
    ).toBe(true);
    const content = await run(
      tools,
      call('find_text', { phrase: 'vibração', output_mode: 'content' }),
    );
    expect(
      listed(content.output).every((line) => line.includes(' · autoria: ')),
    ).toBe(true);
  });

  it('greps only the Mestre documents with authorship, never a book that quotes him', async () => {
    const tools = await memoryTools(new MemoryVault(corpus()));
    const { steps, output } = await run(
      tools,
      call('find_text', { phrase: 'vibração', authorship: 'mestre-laercio' }),
    );
    expect(steps[0]?.text).toBe(
      'Procurando o texto “vibração” em documentos de autoria Mestre Laércio',
    );
    expect(output.split('\n')[0]).toMatch(
      /^Texto “vibração” \(autoria: Mestre Laércio\): 3 documento\(s\)/,
    );
    const lines = listed(output);
    expect(lines).toHaveLength(3);
    expect(
      lines.every((line) => line.includes('autoria: Mestre Laércio')),
    ).toBe(true);
    expect(output).not.toContain('Artigo de um leitor');
  });

  it('lists every document of a group without a phrase', async () => {
    const tools = await memoryTools(new MemoryVault(corpus()));
    const { steps, output } = await run(
      tools,
      call('find_text', { authorship: 'outros-autores' }),
    );
    expect(steps[0]?.text).toBe(
      'Listando os documentos de autoria Outros autores',
    );
    expect(output.split('\n')[0]).toBe(
      'Documentos com autoria Outros autores: 2 documento(s). Mostrando 1–2 de 2.',
    );
    expect(listed(output)).toHaveLength(2);
  });

  it('refuses an unknown authorship and authorship with document', async () => {
    const tools = await memoryTools(new MemoryVault(corpus()));
    const unknown = await run(
      tools,
      call('find_text', { phrase: 'vibração', authorship: 'laercio' }),
    );
    expect(unknown.steps).toEqual([]);
    expect(unknown.output).toMatch(/^Argumentos inválidos .*authorship/);
    const withDocument = await run(
      tools,
      call('find_text', {
        phrase: 'vibração',
        document: 'raw/articles/tema-1.md',
        authorship: 'mestre-laercio',
      }),
    );
    expect(withDocument.output).toMatch(/^Argumentos inválidos .*document/);
    for (const name of ['search_collection', 'list_sources']) {
      const refused = await run(
        tools,
        call(name, { query: 'vibração', authorship: 'Mestre Laércio' }),
      );
      expect(refused.steps).toEqual([]);
      expect(refused.output).toMatch(/^Argumentos inválidos .*authorship/);
    }
  });

  it('filters search_collection by authorship and labels its hits', async () => {
    const hits = Object.keys(corpus()).map((id, i) => ({
      id,
      score: 1 - i / 100,
      snippet: 'a vibração',
    }));
    const index = new FixedIndex(hits);
    const tools = await memoryTools(new MemoryVault(corpus()), index);
    const { output } = await run(
      tools,
      call('search_collection', {
        query: 'vibração',
        authorship: 'outros-autores',
      }),
    );
    expect(output.split('\n')[0]).toMatch(
      /^Busca “vibração” \(modo all; autoria: Outros autores\): 1–2 de 2 documento\(s\)/,
    );
    const lines = listed(output);
    expect(lines.map((line) => line.split(' · ')[0])).toEqual([
      '[1] O Caibalion',
      '[2] Artigo de um leitor',
    ]);
    expect(
      lines.every((line) => line.includes('autoria: Outros autores')),
    ).toBe(true);
    const plain = await run(
      tools,
      call('search_collection', { query: 'vibração', limit: 1 }),
    );
    expect(listed(plain.output)[0]).toMatch(
      /^\[1\] Tema 1 · autoria: Mestre Laércio — /,
    );
  });

  it('counts documents per authorship in list_sources and narrows the lists to one group', async () => {
    const tools = await memoryTools(new MemoryVault(corpus()));
    const all = await run(tools, call('list_sources', {}));
    expect(all.output.split('\n')[0]).toBe(
      'Autoria: Mestre Laércio 3 · Outros autores 2 · Síntese do acervo 1 · Não classificado 1 documento(s).',
    );
    const mestre = await run(
      tools,
      call('list_sources', { kind: 'sources', authorship: 'mestre-laercio' }),
    );
    expect(mestre.steps[0]?.text).toBe(
      'Listando as origens e entidades de autoria Mestre Laércio',
    );
    expect(mestre.output.split('\n')[0]).toMatch(
      /^Autoria: Mestre Laércio 3 · /,
    );
    expect(mestre.output).toContain('- Temas-docs (3 documento(s))');
    expect(mestre.output).not.toContain('Livros');
    expect(mestre.output).not.toContain('Artigos dos Leitores');
  });

  it('states authorship and author when reading, and numbers sources with them', async () => {
    const tools = await memoryTools(new MemoryVault(corpus()));
    const ctx = context();
    const { output } = await run(
      tools,
      call('read_documents', {
        documents: ['raw/articles/tema-1.md', 'raw/articles/caibalion.md'],
      }),
      ctx,
    );
    expect(output).toContain(
      'Autoria: Mestre Laércio (autor: José Laércio do Egito)',
    );
    expect(output).toContain(
      'Autoria: Outros autores (não é do Mestre Laércio; diga o autor ou o livro ao citar)',
    );
    expect(ctx.book.list()).toEqual([
      {
        n: 1,
        id: 'raw/articles/tema-1.md',
        title: 'Tema 1',
        authorship: 'mestre-laercio',
        author: MESTRE,
      },
      {
        n: 2,
        id: 'raw/articles/caibalion.md',
        title: 'O Caibalion',
        authorship: 'outros-autores',
      },
    ]);
  });
});
