import { describe, expect, it } from 'vitest';
import {
  fixtureTools,
  hermetismoContext,
} from '../../../test/research-factories.js';
import type { ToolCall } from '../../ports/llm.js';
import type { ResearchTools, ToolContext } from './tools.js';

const call = (name: string, args: object | string): ToolCall => ({
  id: 'c1',
  name,
  arguments: typeof args === 'string' ? args : JSON.stringify(args),
});

async function run(
  tools: ResearchTools,
  context: ToolContext,
  toolCall: ToolCall,
) {
  const prepared = tools.prepare(toolCall, context);
  return {
    step: prepared.steps[0] ?? null,
    steps: prepared.steps,
    output: await prepared.run(),
  };
}

describe('ResearchTools definitions', () => {
  it('declares the seven tools with JSON Schema parameters', async () => {
    const tools = await fixtureTools();
    expect(tools.definitions.map((t) => t.name)).toEqual([
      'search_collection',
      'find_text',
      'list_subjects',
      'list_sources',
      'read_document',
      'read_documents',
      'related_documents',
    ]);
    // Batched reads are the preferred way to read several documents (KBC-011 FR-6).
    expect(
      tools.definitions.find((t) => t.name === 'read_documents')?.description,
    ).toContain('Use no lugar de read_document quando for ler mais de um');
    const search = tools.definitions[0]?.parameters;
    expect(search).toMatchObject({
      type: 'object',
      required: ['query'],
      properties: {
        mode: { enum: ['all', 'exact', 'semantic'], default: 'all' },
        limit: { maximum: 30 },
      },
    });
    expect(search).not.toHaveProperty('$schema');
    expect(tools.topicTitle('hermetismo')).toBe('Hermetismo');
    expect(tools.topicTitle('nope')).toBeNull();
  });
});

describe('search_collection', () => {
  it('lists numbered hits with title, kb summary, snippet and subjects', async () => {
    const tools = await fixtureTools();
    const context = hermetismoContext();
    const { step, output } = await run(
      tools,
      context,
      call('search_collection', { query: 'pitagóricos', mode: 'exact' }),
    );
    expect(step).toEqual({ kind: 'search', text: 'Buscando “pitagóricos”' });
    expect(output).toContain('Busca “pitagóricos” (modo exact)');
    expect(output).toMatch(
      /\[1\] A Lei do Ritmo — Resumo: O texto explora a Lei do Ritmo.* — Trecho: .*pitagóricos.* — Assuntos: Hermetismo e Filosofia Hermética/,
    );
    expect(context.book.find(1)?.id).toBe('raw/articles/a-lei-do-ritmo.md');
  });

  it('keeps numbers stable across searches and limits the hits', async () => {
    const tools = await fixtureTools();
    const context = hermetismoContext();
    await run(
      tools,
      context,
      call('search_collection', { query: 'ritmo', limit: 3 }),
    );
    expect(context.book.size).toBe(3);
    const first = context.book.find(1)?.id;
    const again = await run(
      tools,
      context,
      call('search_collection', { query: 'ritmo', limit: 5 }),
    );
    expect(context.book.find(1)?.id).toBe(first);
    expect(context.book.size).toBe(5);
    expect(again.output).toContain('[1] ');
  });

  it('filters by subject, matching the catalog name without accents or case', async () => {
    const tools = await fixtureTools();
    const { output } = await run(
      tools,
      hermetismoContext(),
      call('search_collection', {
        query: 'ritmo',
        subjects: ['hermetismo e filosofia hermetica'],
      }),
    );
    expect(output).toContain('assuntos: Hermetismo e Filosofia Hermética');
    expect(output).not.toMatch(/\] Ritmo —/);
    expect(output).toMatch(/: 1–8 de 13 documento/);
  });

  it('tells the model to re-phrase when nothing is found', async () => {
    const tools = await fixtureTools();
    const { output } = await run(
      tools,
      hermetismoContext(),
      call('search_collection', { query: 'xqzw kplvm' }),
    );
    expect(output).toMatch(/Nenhum documento encontrado .* Tente sinônimos/);
  });

  it('answers invalid arguments with a correction request and no step', async () => {
    const tools = await fixtureTools();
    const context = hermetismoContext();
    const bad = await run(
      tools,
      context,
      call('search_collection', { query: 'x', limit: 99 }),
    );
    expect(bad.step).toBeNull();
    expect(bad.output).toMatch(/Argumentos inválidos \(limit: .*\)/);
    const broken = await run(
      tools,
      context,
      call('search_collection', '{oops'),
    );
    expect(broken.output).toMatch(/Argumentos inválidos/);
    const unknown = await run(tools, context, call('delete_vault', {}));
    expect(unknown).toEqual({
      step: null,
      steps: [],
      output: 'Ferramenta desconhecida: delete_vault.',
    });
  });

  it('reports a failing index as text for the model', async () => {
    const tools = await fixtureTools();
    const { output } = await run(
      tools,
      { topic: 'no-such-topic', book: hermetismoContext().book },
      call('search_collection', { query: 'ritmo' }),
    );
    expect(output).toBe(
      'A ferramenta falhou (TOPIC_NOT_FOUND). Tente de novo ou use outra ferramenta.',
    );
  });
});

describe('find_text', () => {
  it('finds a literal phrase in every document, numbered and ranked by occurrences', async () => {
    const tools = await fixtureTools();
    const context = hermetismoContext();
    const { step, output } = await run(
      tools,
      context,
      call('find_text', { phrase: 'SETUPLICIDADE | setuplicidade | sétupla' }),
    );
    expect(step).toEqual({
      kind: 'search',
      text: 'Procurando o texto “SETUPLICIDADE | setuplicidade | sétupla” em todo o acervo',
    });
    const lines = output.split('\n');
    expect(lines[0]).toMatch(
      /^Texto “SETUPLICIDADE” ou “sétupla”: 3 documento\(s\), \d+ ocorrência\(s\), em 22 documentos varridos\. Mostrando 1–3 de 3\.$/,
    );
    expect(lines[1]).toMatch(
      /^\[1\] A Natureza Sétupla · \d+ ocorrência\(s\) \(“sétupla” \d+, “SETUPLICIDADE” 1\) · origem: .* — Trecho: .*setuplicidade/,
    );
    expect(context.book.size).toBe(3);
    expect(output).toContain('output_mode content');
    expect(output.split('\n').at(-1)).toBe('Fim da lista.');
  });

  it('asks for variants before concluding absence, and refuses too-short phrases', async () => {
    const tools = await fixtureTools();
    const context = hermetismoContext();
    const none = await run(
      tools,
      context,
      call('find_text', { phrase: 'princípios ocultos | doze princípios' }),
    );
    expect(none.output).toMatch(
      /^Nenhum dos 22 documentos contém “princípios ocultos” ou “doze princípios”\. Antes de concluir .* sinônimos \(ocultos, secretos, velados/,
    );
    const short = await run(
      tools,
      context,
      call('find_text', { phrase: 'ab | cd' }),
    );
    expect(short.step).toBeNull();
    expect(short.output).toMatch(/^Texto curto demais/);
    const big = await run(
      tools,
      context,
      call('find_text', { phrase: 'ritmo', limit: 201 }),
    );
    expect(big.output).toMatch(/Argumentos inválidos \(limit: /);
  });
});

describe('list_subjects', () => {
  it('lists subjects with document counts, largest first, optionally filtered', async () => {
    const tools = await fixtureTools();
    const all = await run(
      tools,
      hermetismoContext(),
      call('list_subjects', {}),
    );
    expect(all.step).toEqual({
      kind: 'subjects',
      text: 'Listando os assuntos',
    });
    expect(all.output.split('\n')[1]).toMatch(
      /^- Hermetismo e Filosofia Hermética \(\d+ documento\(s\)\)$/,
    );
    const cabala = await run(
      tools,
      hermetismoContext(),
      call('list_subjects', { query: 'CABALA' }),
    );
    expect(cabala.step?.text).toBe('Listando os assuntos sobre “CABALA”');
    expect(cabala.output).toContain('- Cabala (');
    const none = await run(
      tools,
      hermetismoContext(),
      call('list_subjects', { query: 'astronáutica' }),
    );
    expect(none.output).toBe('Nenhum assunto encontrado com “astronáutica”.');
  });
});

describe('read_document', () => {
  it('reads a document by [n] with the kb summary, facets and a fenced body', async () => {
    const tools = await fixtureTools();
    const context = hermetismoContext();
    await run(
      tools,
      context,
      call('search_collection', { query: 'lei do ritmo', mode: 'exact' }),
    );
    const { step, output } = await run(
      tools,
      context,
      call('read_document', { document: 1 }),
    );
    expect(step).toEqual({
      kind: 'read',
      text: 'Lendo “A Lei do Ritmo”',
      document: 'raw/articles/a-lei-do-ritmo.md',
    });
    expect(output).toContain('[1] A Lei do Ritmo');
    expect(output).toContain('Resumo do kb: O texto explora a Lei do Ritmo');
    expect(output).toContain(
      'Facetas: gênero: article_or_essay; profundidade: 2; relevância: core',
    );
    expect(output).toMatch(
      /<<<DOCUMENTO\n[\s\S]*pitagóricos[\s\S]*\nDOCUMENTO>>>\nFim do documento\./,
    );
  });

  it('reads by id or "[n]", centers on `around` and tells how to read further', async () => {
    const tools = await fixtureTools();
    const context = hermetismoContext();
    const byId = await run(
      tools,
      context,
      call('read_document', {
        document: 'raw/articles/tratado-longo.md',
        around: 'RESPIRAÇÃO consciente',
      }),
    );
    expect(byId.output).toMatch(
      /caracteres 0 a 12000 de \d+ \(em volta de “RESPIRAÇÃO consciente”, \d+ ocorrência\(s\) neste trecho\)/,
    );
    expect(byId.output).toContain(
      'read_document com document=1 e offset=12000',
    );
    const next = await run(
      tools,
      context,
      call('read_document', { document: '[1]', offset: 12_000 }),
    );
    expect(next.output).toContain('caracteres 12000 a 24000');
  });

  it('refuses unknown references without a step', async () => {
    const tools = await fixtureTools();
    const context = hermetismoContext();
    const missing = await run(
      tools,
      context,
      call('read_document', { document: 7 }),
    );
    expect(missing).toEqual({
      step: null,
      steps: [],
      output:
        'Documento [7] não encontrado. Use o número [n] de um resultado de busca ou de uma ligação.',
    });
    const outside = await run(
      tools,
      context,
      call('read_document', { document: '../../etc/passwd' }),
    );
    expect(outside.output).toMatch(
      /^Documento “\.\.\/\.\.\/etc\/passwd” não encontrado/,
    );
  });
});

describe('read_documents (KBC-011)', () => {
  it('reads several documents in one call, one step each, a 6,000-character window each', async () => {
    const tools = await fixtureTools();
    const context = hermetismoContext();
    await run(
      tools,
      context,
      call('search_collection', { query: 'lei do ritmo', mode: 'exact' }),
    );
    const { steps, output } = await run(
      tools,
      context,
      call('read_documents', {
        documents: [1, 'raw/articles/tratado-longo.md', 1],
        around: 'respiração',
      }),
    );
    expect(steps).toEqual([
      {
        kind: 'read',
        text: 'Lendo “A Lei do Ritmo”',
        document: 'raw/articles/a-lei-do-ritmo.md',
      },
      {
        kind: 'read',
        text: expect.stringMatching(/^Lendo “/),
        document: 'raw/articles/tratado-longo.md',
      },
    ]);
    expect(output).toContain('[1] A Lei do Ritmo');
    expect(output).toMatch(/caracteres \d+ a \d+ de \d+/);
    const longest = Math.max(
      ...[...output.matchAll(/<<<DOCUMENTO\n([\s\S]*?)\nDOCUMENTO>>>/g)].map(
        (m) => m[1]?.length ?? 0,
      ),
    );
    expect(longest).toBeLessThanOrEqual(6_000);
  });

  it('reads what it finds and names what it could not, and refuses more than 4', async () => {
    const tools = await fixtureTools();
    const context = hermetismoContext();
    const partial = await run(
      tools,
      context,
      call('read_documents', {
        documents: ['raw/articles/a-lei-do-ritmo.md', 9],
      }),
    );
    expect(partial.steps).toHaveLength(1);
    expect(partial.output).toContain('Documento [9] não encontrado');
    const none = await run(
      tools,
      context,
      call('read_documents', { documents: [8, 9] }),
    );
    expect(none).toMatchObject({ steps: [] });
    expect(none.output).toMatch(/^Documento \[8\] não encontrado/);
    const many = await run(
      tools,
      context,
      call('read_documents', { documents: [1, 2, 3, 4, 5] }),
    );
    expect(many.output).toMatch(/^Argumentos inválidos/);
  });
});

describe('related_documents', () => {
  it('lists the kb relations as numbered references', async () => {
    const tools = await fixtureTools();
    const context = hermetismoContext();
    const { step, output } = await run(
      tools,
      context,
      call('related_documents', { document: 'wiki/concepts/Ritmo.md' }),
    );
    expect(step).toEqual({
      kind: 'related',
      text: 'Seguindo as ligações de “Ritmo”',
    });
    expect(output).toContain('Ligações de [1] Ritmo:');
    expect(output).toMatch(
      /Exemplos \(12\):\n\[2\] Ritmo, lição 01 — Lição 01 da série/,
    );
    expect(output.match(/^\[\d+\]/gm)).toHaveLength(10);
    expect(context.book.size).toBe(11);
  });

  it('says when a document has no relations', async () => {
    const tools = await fixtureTools();
    const { output } = await run(
      tools,
      hermetismoContext(),
      call('related_documents', { document: 'raw/articles/tratado-longo.md' }),
    );
    expect(output).toBe('[1] Tratado Longo não tem ligações no kb.');
  });
});
