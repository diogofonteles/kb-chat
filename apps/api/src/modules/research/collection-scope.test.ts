import type { ResearchEvent, ResearchProfile } from '@kb-chat/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { collectEvents } from '../../../test/research-factories.js';
import {
  OPEN_SHELF,
  TRACK_IDS,
  scopeWorld,
  type ScopeWorld,
} from '../../../test/scope-vault.js';
import { MemorySpendLedger } from '../../adapters/memory-spend-ledger.js';
import {
  StubLlmAdapter,
  type StubReply,
} from '../../adapters/stub-llm-adapter.js';
import type { ToolCall } from '../../ports/llm.js';
import { OPEN_VIEW } from '../access-levels/index.js';
import { SpendService } from '../spend/index.js';
import { SourceBook } from './source-book.js';
import { ToolLoopRunner } from './tool-loop-runner.js';
import type { ToolContext } from './tools.js';
import { TurnResearchTools } from './turn-tools.js';

/**
 * A research run only ever reaches the conversation's collection and, for a parent, its
 * sub-collections (ADR 0028): never another top-level collection, whatever the model asks.
 */

const UDV_TITLES = [
  'O Vegetal',
  'Comum UDV',
  'Faixa UDV',
  'A Palavra',
  'Faixa Palavra',
];
/** What only UDV's documents say: a query's echo may name its words, never these. */
const UDV_WORDS = [
  'Mestre Gabriel',
  'O chá é feito',
  'colhida no ritmo',
  'O Mestre fala',
  'Ensinos sobre',
  'Fala sobre a chacrona',
];

let world: ScopeWorld;
beforeAll(async () => {
  world = await scopeWorld();
});

const contextOf = (topic: string): ToolContext => ({
  topic,
  book: new SourceBook(),
  view: OPEN_VIEW,
  tracks: OPEN_SHELF,
});

const call = (name: string, args: object): ToolCall => ({
  id: 'c1',
  name,
  arguments: JSON.stringify(args),
});

async function run(context: ToolContext, name: string, args: object) {
  const prepared = world.tools.prepare(call(name, args), context);
  return { steps: prepared.steps, output: await prepared.run() };
}

/** Nothing of UDV or Palavra do Mestre in a tool's output or the turn's sources. */
function expectNoUdv(output: string, context: ToolContext): void {
  for (const word of [...UDV_TITLES, ...UDV_WORDS])
    expect(output.toLowerCase()).not.toContain(word.toLowerCase());
  for (const source of context.book.list()) {
    expect(UDV_TITLES).not.toContain(source.title);
    expect(world.catalog.get('hermetismo')?.entries.has(source.id)).toBe(true);
  }
}

describe('search_collection stays in the collection', () => {
  it('finds nothing on Hermetismo for words only UDV says, the tracks included', async () => {
    const context = contextOf('hermetismo');
    const { output } = await run(context, 'search_collection', {
      query: 'chacrona mariri',
    });
    expect(output).toContain('Nenhum documento encontrado');
    expectNoUdv(output, context);
    expect(context.book.size).toBe(0);
  });

  it('keeps Hermetismo hits only when every collection matches the query', async () => {
    const context = contextOf('hermetismo');
    const { output } = await run(context, 'search_collection', {
      query: 'ritmo',
    });
    expect(output).toContain('O Caibalion');
    expect(output).toContain('Faixa Hermetismo');
    expectNoUdv(output, context);
  });

  it('includes Palavra do Mestre on UDV, never Hermetismo', async () => {
    const context = contextOf('udv');
    const { output } = await run(context, 'search_collection', {
      query: 'ritmo',
    });
    for (const title of UDV_TITLES) expect(output).toContain(title);
    expect(output).not.toContain('Caibalion');
    expect(output).not.toContain('Hermetismo');
    expect(context.book.list().map((s) => s.id)).toEqual(
      expect.arrayContaining([
        'palavra-do-mestre/raw/articles/palavra.md',
        `palavra-do-mestre/${TRACK_IDS.palavra}`,
      ]),
    );
  });

  it('keeps a sub-collection to itself: Palavra do Mestre never reaches its parent', async () => {
    const context = contextOf('udv/palavra-do-mestre');
    const { output } = await run(context, 'search_collection', {
      query: 'ritmo',
    });
    expect(output).toContain('A Palavra');
    for (const title of ['O Vegetal', 'Comum UDV', 'Faixa UDV', 'Caibalion'])
      expect(output).not.toContain(title);
  });
});

describe('find_text, list_subjects and list_sources stay in the collection', () => {
  it('greps nothing of UDV on Hermetismo, in every output mode', async () => {
    for (const output_mode of ['files', 'count', 'content']) {
      const context = contextOf('hermetismo');
      const { output } = await run(context, 'find_text', {
        phrase: 'chacrona',
        output_mode,
      });
      expectNoUdv(output, context);
      expect(context.book.size).toBe(0);
    }
  });

  it('greps Hermetismo only for a phrase every collection says', async () => {
    const context = contextOf('hermetismo');
    const { output } = await run(context, 'find_text', { phrase: 'ritmo' });
    expect(output).toContain('O Caibalion');
    expectNoUdv(output, context);
  });

  it('greps the parent and its sub-collection on UDV', async () => {
    const context = contextOf('udv');
    const { output } = await run(context, 'find_text', { phrase: 'chacrona' });
    for (const title of ['O Vegetal', 'A Palavra', 'Faixa Palavra'])
      expect(output).toContain(title);
    expect(output).not.toContain('Caibalion');
  });

  it("names no UDV origin or entity in Hermetismo's sources", async () => {
    const context = contextOf('hermetismo');
    const { output } = await run(context, 'list_sources', {});
    expect(output).toContain('Hermes Trismegisto');
    expect(output).not.toContain('sessoes');
    expectNoUdv(output, context);
  });
});

/** Every way a model might name a UDV document while researching Hermetismo. */
const FOREIGN_REFS = [
  'raw/sessoes/vegetal.md',
  '../udv/raw/sessoes/vegetal.md',
  'udv/raw/sessoes/vegetal.md',
  '/udv/raw/sessoes/vegetal.md',
  'raw/../../udv/raw/sessoes/vegetal.md',
  'palavra-do-mestre/raw/articles/palavra.md',
  'udv/palavra-do-mestre/raw/articles/palavra.md',
  '../udv/palavra-do-mestre/raw/articles/palavra.md',
  TRACK_IDS.udv,
  `../udv/${TRACK_IDS.udv}`,
];

describe('reads of another collection are refused', () => {
  it.each(FOREIGN_REFS)(
    'read_document refuses %s on Hermetismo',
    async (ref) => {
      const context = contextOf('hermetismo');
      const { steps, output } = await run(context, 'read_document', {
        document: ref,
      });
      expect(steps).toEqual([]);
      expect(output).toContain('não encontrado');
      expectNoUdv(output, context);
    },
  );

  it('refuses them in read_documents, related_documents and find_text by document', async () => {
    const context = contextOf('hermetismo');
    const many = await run(context, 'read_documents', {
      documents: FOREIGN_REFS.slice(0, 4),
    });
    expect(many.steps).toEqual([]);
    expectNoUdv(many.output, context);
    for (const ref of FOREIGN_REFS) {
      const related = await run(context, 'related_documents', {
        document: ref,
      });
      expect(related.steps).toEqual([]);
      const grep = await run(context, 'find_text', {
        phrase: 'chacrona',
        document: ref,
      });
      expect(grep.steps).toEqual([]);
      expectNoUdv(`${related.output}\n${grep.output}`, context);
    }
  });

  it("reads Hermetismo's own document where UDV has one with the same id", async () => {
    const context = contextOf('hermetismo');
    const { output } = await run(context, 'read_document', {
      document: 'raw/articles/comum.md',
    });
    expect(output).toContain('marés');
    expectNoUdv(output, context);
  });

  it('reads Palavra do Mestre from UDV, but never UDV or Hermetismo from Palavra do Mestre', async () => {
    const fromUdv = await run(contextOf('udv'), 'read_document', {
      document: 'palavra-do-mestre/raw/articles/palavra.md',
    });
    expect(fromUdv.output).toContain('O Mestre fala do mariri');
    for (const ref of [
      '../raw/sessoes/vegetal.md',
      '../../hermetismo/raw/articles/caibalion.md',
      'raw/sessoes/vegetal.md',
    ]) {
      const { steps } = await run(
        contextOf('udv/palavra-do-mestre'),
        'read_document',
        { document: ref },
      );
      expect(steps).toEqual([]);
    }
  });
});

describe('the exhaustive sweep plans over the collection only (ADR 0021)', () => {
  const plan = (phrases: string[]) => ({
    target: {},
    phrases,
    extract: 'tudo',
  });
  const layoutOf = (topic: string, phrases: string[]) =>
    world.tools.sweeps.layout(topic, {
      plan: plan(phrases),
      batchChars: 50_000,
      view: OPEN_VIEW,
      tracks: OPEN_SHELF,
    });

  it("sweeps Hermetismo's documents and tracks, none with UDV's words", async () => {
    const whole = await layoutOf('hermetismo', []);
    expect(whole?.docs.map((d) => d.entry.id)).toEqual([
      'raw/articles/caibalion.md',
      'raw/articles/comum.md',
      TRACK_IDS.hermetismo,
    ]);
    const hits = await layoutOf('hermetismo', ['chacrona']);
    expect(hits?.withHits).toBe(0);
    expect(hits?.batches).toEqual([]);
  });

  it('sweeps UDV with Palavra do Mestre in it', async () => {
    const layout = await layoutOf('udv', ['chacrona']);
    const swept = layout?.docs
      .filter((d) => d.units.length > 0)
      .map((d) => d.entry.id);
    expect(swept).toEqual(
      expect.arrayContaining([
        'raw/sessoes/vegetal.md',
        'palavra-do-mestre/raw/articles/palavra.md',
        `palavra-do-mestre/${TRACK_IDS.palavra}`,
      ]),
    );
    expect(swept?.every((id) => !id.includes('caibalion'))).toBe(true);
  });
});

/** A model that tries every way out of Hermetismo before it answers. */
const ESCAPES: StubReply[] = [
  {
    toolCalls: [
      { name: 'search_collection', arguments: { query: 'chacrona mariri' } },
      { name: 'search_collection', arguments: { query: 'ritmo' } },
      { name: 'find_text', arguments: { phrase: 'chacrona' } },
      { name: 'list_sources', arguments: {} },
    ],
  },
  {
    toolCalls: FOREIGN_REFS.slice(0, 6).map((document) => ({
      name: 'read_document',
      arguments: { document },
    })),
  },
  {
    toolCalls: [
      { name: 'read_documents', arguments: { documents: [1, 2, 3] } },
      { name: 'find_text', arguments: { phrase: 'ritmo' } },
    ],
  },
  { text: 'Resposta [1] [2] [3] [4] [5].' },
];

const sourcesOf = (events: readonly ResearchEvent[]) =>
  events.flatMap((event) => (event.type === 'sources' ? event.sources : []));

async function researchHermetismo(profile: ResearchProfile) {
  const llm = new StubLlmAdapter({ script: ESCAPES });
  const spend = new SpendService({
    llm,
    ledger: new MemorySpendLedger(),
    dailyCapUsd: () => 5,
    principal: 'owner',
  });
  const runner = new ToolLoopRunner({ llm, tools: world.tools, spend });
  return collectEvents(
    runner.run({
      topic: 'hermetismo',
      question: 'O que é a chacrona e o mariri?',
      history: [],
      profile,
      signal: new AbortController().signal,
      view: OPEN_VIEW,
      tracks: OPEN_SHELF,
    }),
  );
}

describe('a whole research turn on Hermetismo cites Hermetismo only', () => {
  it.each(['fast', 'deep'] as const)(
    'the %s profile, with a model asking for UDV every way it can',
    async (profile) => {
      const events = await researchHermetismo(profile);
      const sources = sourcesOf(events);
      expect(sources.length).toBeGreaterThan(0);
      const own = world.catalog.get('hermetismo')?.entries;
      for (const source of sources) {
        expect(own?.has(source.id)).toBe(true);
        expect(UDV_TITLES).not.toContain(source.title);
      }
      const shown = JSON.stringify(events).toLowerCase();
      for (const title of UDV_TITLES)
        expect(shown).not.toContain(title.toLowerCase());
    },
  );

  it('the exhaustive profile sweeps and cites Hermetismo only', async () => {
    const llm = new StubLlmAdapter({});
    const spend = new SpendService({
      llm,
      ledger: new MemorySpendLedger(),
      dailyCapUsd: () => 5,
      principal: 'owner',
    });
    const runner = new ToolLoopRunner({ llm, tools: world.tools, spend });
    const events = await collectEvents(
      runner.run({
        topic: 'hermetismo',
        question: 'Liste tudo o que o acervo diz sobre o ritmo',
        history: [],
        profile: 'exhaustive',
        signal: new AbortController().signal,
        view: OPEN_VIEW,
        tracks: OPEN_SHELF,
      }),
    );
    const done = events.find((event) => event.type === 'done');
    expect(done, JSON.stringify(events.at(-1))).toBeDefined();
    const own = world.catalog.get('hermetismo')?.entries;
    const sources = sourcesOf(events);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) expect(own?.has(source.id)).toBe(true);
    const shown = JSON.stringify(events).toLowerCase();
    for (const title of UDV_TITLES)
      expect(shown).not.toContain(title.toLowerCase());
  });
});

describe("the subscription CLIs' MCP tools are bound to the turn's collection (ADR 0007)", () => {
  it('refuses a UDV document by id or path and searches Hermetismo only', async () => {
    const tools = new TurnResearchTools(world.tools, 'hermetismo', {
      view: OPEN_VIEW,
      tracks: OPEN_SHELF,
    });
    for (const document of FOREIGN_REFS) {
      const read = await tools.call('read_document', { document });
      expect(read.steps).toEqual([]);
      expect(read.sources).toEqual([]);
    }
    const found = await tools.call('find_text', { phrase: 'chacrona' });
    const searched = await tools.call('search_collection', {
      query: 'ritmo chacrona',
    });
    for (const text of [found.text, searched.text])
      for (const title of UDV_TITLES) expect(text).not.toContain(title);
    const own = world.catalog.get('hermetismo')?.entries;
    for (const source of searched.sources)
      expect(own?.has(source.id)).toBe(true);
  });
});
