import { describe, expect, it } from 'vitest';
import { fixtureTools } from '../../../test/research-factories.js';
import { turnToolsFactory } from './turn-tools.js';

describe('TurnResearchTools (the MCP side of the research tools)', () => {
  it('runs the module tools with cumulative [n] sources for the turn', async () => {
    const tools = turnToolsFactory(await fixtureTools())('hermetismo');
    expect(tools.definitions().map((tool) => tool.name)).toContain('find_text');
    const search = await tools.call('search_collection', {
      query: 'pitagóricos',
      mode: 'exact',
    });
    expect(search.steps).toEqual([
      { kind: 'search', text: 'Buscando “pitagóricos”' },
    ]);
    expect(search.text).toContain('[1] A Lei do Ritmo');
    expect(search.sources[0]).toEqual({
      n: 1,
      id: 'raw/articles/a-lei-do-ritmo.md',
      title: 'A Lei do Ritmo',
    });
    const read = await tools.call('read_document', { document: '[1]' });
    expect(read.steps).toEqual([
      {
        kind: 'read',
        text: 'Lendo “A Lei do Ritmo”',
        document: 'raw/articles/a-lei-do-ritmo.md',
      },
    ]);
    expect(read.sources).toEqual(search.sources);
    const found = await tools.call('find_text', {
      phrase: 'tudo flui | nada repousa',
    });
    expect(found.steps[0]?.kind).toBe('search');
    expect(found.sources.length).toBeGreaterThanOrEqual(search.sources.length);
  });

  it('numbers each turn on its own', async () => {
    const factory = turnToolsFactory(await fixtureTools());
    await factory('hermetismo').call('search_collection', { query: 'ritmo' });
    const fresh = await factory('hermetismo').call('list_subjects', {});
    expect(fresh.sources).toEqual([]);
    expect(fresh.steps).toEqual([
      { kind: 'subjects', text: 'Listando os assuntos' },
    ]);
  });

  it('answers invalid arguments as text with no step, and rejects unknown tools', async () => {
    const tools = turnToolsFactory(await fixtureTools())('hermetismo');
    const invalid = await tools.call('search_collection', { query: 42 });
    expect(invalid.steps).toEqual([]);
    expect(invalid.text).toMatch(/^Argumentos inválidos/);
    await expect(tools.call('write_file', {})).rejects.toThrow(
      'Unknown tool write_file',
    );
  });
});
