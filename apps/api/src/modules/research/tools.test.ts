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
  return { step: prepared.step, output: await prepared.run() };
}

describe('ResearchTools definitions', () => {
  it('declares the four tools with JSON Schema parameters', async () => {
    const tools = await fixtureTools();
    expect(tools.definitions.map((t) => t.name)).toEqual([
      'search_collection',
      'list_subjects',
      'read_document',
      'related_documents',
    ]);
    const search = tools.definitions[0]?.parameters;
    expect(search).toMatchObject({
      type: 'object',
      required: ['query'],
      properties: {
        mode: { enum: ['all', 'exact', 'semantic'], default: 'all' },
        limit: { maximum: 15 },
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
    expect(output).toMatch(/: 8 de 13 documento/);
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
    expect(step).toEqual({ kind: 'read', text: 'Lendo “A Lei do Ritmo”' });
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
