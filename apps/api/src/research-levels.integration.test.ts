import type { ResearchEvent } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp, events, type Call } from '../test/ai-app-harness.js';
import {
  HIDDEN_TITLES,
  SIX,
  memberOf,
  placeDocuments,
  setPersonLevel,
  sixAtThreeLevels,
  startLevels,
  type LevelsWorld,
} from '../test/levels-world.js';
import { StubLlmAdapter, type StubReply } from './adapters/stub-llm-adapter.js';

/*
 * KBC-104 (ADR 0036 §7): AI research sees only what the person may read. Ana is at CI in
 * QS < CI < CDC, two documents with "lua" per level; a scripted stub model calls the tools,
 * and every byte of the SSE stream and every tool output is checked for the CDC ones.
 */

afterEach(closeApp);

const OPEN_TITLES = [
  'Lua Primeira Aberta',
  'Lua Segunda Aberta',
  'Lua Media Uno',
  'Lua Media Duo',
];

const call = (name: string, args: Record<string, unknown>): StubReply => ({
  toolCalls: [{ name, arguments: args }],
});

/** search_collection, find_text and list_sources over "lua", then an answer citing [1]. */
const LOOKING: readonly StubReply[] = [
  call('search_collection', { query: 'lua', mode: 'all' }),
  call('find_text', { phrase: 'lua', output_mode: 'files' }),
  call('list_sources', {}),
  call('list_subjects', {}),
  { text: 'Segundo o acervo, a lua aparece em vários graus [1].' },
];

interface ResearchWorld {
  readonly world: LevelsWorld;
  readonly ana: Awaited<ReturnType<typeof memberOf>>;
  readonly llm: StubLlmAdapter;
}

/** Ana at CI over the six documents, the stub model following `script`. */
async function anaResearching(
  script: readonly StubReply[],
  options: { readonly level?: string } = {},
): Promise<ResearchWorld> {
  const llm = new StubLlmAdapter({ script });
  const world = await startLevels(SIX, { llm });
  const ana = await memberOf(world, 'ana@example.com');
  await sixAtThreeLevels(world);
  await setPersonLevel(world, ana.id, { hermetismo: options.level ?? 'ci' });
  return { world, ana, llm };
}

interface Turn {
  readonly status: number;
  /** The raw SSE body: every event, as the browser gets it. */
  readonly body: string;
  readonly stream: ResearchEvent[];
  /** Everything the tools told the model this turn. */
  readonly told: string;
  /** Each tool output of the turn, in order. */
  readonly outputs: string[];
}

async function ask(
  who: Call,
  llm: StubLlmAdapter,
  topic = 'hermetismo',
): Promise<Turn> {
  const seen = llm.messagesSeen.length;
  const asked = await who(
    'POST',
    `/api/v1/topics/${encodeURIComponent(topic)}/research`,
    { question: 'o que dizem sobre a lua?', profile: 'deep' },
  );
  const turn = llm.messagesSeen.slice(seen).at(-1) ?? [];
  const outputs = turn
    .filter((message) => message.role === 'tool')
    .map((message) => message.content);
  return {
    outputs,
    status: asked.statusCode,
    body: asked.body,
    stream: asked.statusCode === 200 ? events(asked.body) : [],
    told: outputs.join('\n'),
  };
}

/** No CDC title or id anywhere in `text`. */
const expectNoHidden = (text: string) => {
  for (const title of HIDDEN_TITLES) expect(text).not.toContain(title);
  expect(text).not.toContain('cdc-');
};

const sourceTitles = (stream: readonly ResearchEvent[]) =>
  stream.flatMap((event) =>
    event.type === 'sources' ? event.sources.map((one) => one.title) : [],
  );

describe('AI research within the person level (KBC-104)', () => {
  it('AC-1, AC-8: search_collection, find_text, list_sources and list_subjects give Ana only QS and CI, and no SSE event names CDC', async () => {
    const { ana, llm } = await anaResearching(LOOKING);
    const turn = await ask(ana.call, llm);
    expect(turn.status, turn.body).toBe(200);
    expect(turn.body).not.toContain('LEVELS_PENDING');
    for (const title of OPEN_TITLES) expect(turn.told).toContain(title);
    expectNoHidden(turn.told);
    expectNoHidden(turn.body);
    // find_text on its own: the 4 visible documents with "lua", none hidden.
    const found = turn.outputs[1] ?? '';
    for (const title of OPEN_TITLES) expect(found).toContain(title);
    expect(found).toMatch(/\b4 documento/);
    expectNoHidden(found);
    // list_sources counts the visible set only (no hidden count either).
    expect(turn.told).toContain('Outros autores 4 ');
    expect(turn.told).toContain('Astrologia (4 documento(s))');
    expect(turn.stream.at(-1)).toMatchObject({ type: 'done' });
  });

  it('AC-1 (control): the master sees the six with the same script', async () => {
    const { world, llm } = await anaResearching(LOOKING);
    const turn = await ask(world.owner, llm);
    expect(turn.status, turn.body).toBe(200);
    for (const title of [...OPEN_TITLES, ...HIDDEN_TITLES])
      expect(turn.told).toContain(title);
    expect(turn.told).toContain('Outros autores 6 ');
  });

  it('AC-2: a CDC id read by any tool is "não encontrado", word for word like an id that does not exist', async () => {
    const { ana, llm } = await anaResearching([
      call('read_document', { document: 'raw/cdc-1.md' }),
      call('read_document', { document: 'raw/none-1.md' }),
      call('related_documents', { document: 'raw/cdc-1.md' }),
      call('related_documents', { document: 'raw/none-1.md' }),
      call('find_text', { phrase: 'lua', document: 'raw/cdc-1.md' }),
      call('find_text', { phrase: 'lua', document: 'raw/none-1.md' }),
      call('read_documents', { documents: ['raw/cdc-1.md', 'raw/qs-1.md'] }),
      { text: 'Nada velado.' },
    ]);
    const turn = await ask(ana.call, llm);
    expect(turn.status, turn.body).toBe(200);
    const outputs = (llm.messagesSeen.at(-1) ?? [])
      .filter((message) => message.role === 'tool')
      .map((message) => message.content);
    const [
      hidden,
      missing,
      hiddenLinks,
      missingLinks,
      hiddenFind,
      missingFind,
    ] = outputs;
    const same = (text = '') => text.replace(/cdc-1|none-1/g, 'X');
    expect(hidden).toContain('não encontrado');
    expect(same(hidden)).toBe(same(missing));
    expect(same(hiddenLinks)).toBe(same(missingLinks));
    expect(same(hiddenFind)).toBe(same(missingFind));
    // A batch read gives the visible one and refuses the hidden one like a missing one.
    expect(outputs[6]).toContain('Lua Primeira Aberta');
    expect(outputs[6]).not.toContain('grau velado');
    // No step reads it, no source names it.
    const steps = turn.stream.flatMap((event) =>
      event.type === 'step' ? [event.step] : [],
    );
    expect(steps.some((step) => step.document === 'raw/cdc-1.md')).toBe(false);
    expect(sourceTitles(turn.stream)).toEqual(['Lua Primeira Aberta']);
    expect(turn.body).not.toContain('Zircônio Velado');
  });

  it('AC-6: a [n] the turn never gave (a hidden document has none) is not a source', async () => {
    const { ana, llm } = await anaResearching([
      call('search_collection', { query: 'lua', mode: 'all' }),
      call('read_document', { document: 'raw/cdc-2.md' }),
      { text: 'Segundo o acervo, a lua [1] e o véu [7].' },
    ]);
    const turn = await ask(ana.call, llm);
    expect(turn.status, turn.body).toBe(200);
    const titles = sourceTitles(turn.stream);
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) expect(OPEN_TITLES).toContain(title);
    expectNoHidden(turn.body);
  });

  it('AC-7: the master acting as Ana researches with her level; back as himself, with every level', async () => {
    const { world, ana, llm } = await anaResearching(LOOKING);
    const acting = await world.owner(
      'POST',
      `/api/v1/people/${ana.id}/act-as`,
      { reason: 'confere o que a Ana vê' },
    );
    expect(acting.statusCode, acting.body).toBe(200);
    const asAna = await ask(world.owner, llm);
    expect(asAna.status, asAna.body).toBe(200);
    for (const title of OPEN_TITLES) expect(asAna.told).toContain(title);
    expectNoHidden(asAna.told);
    expectNoHidden(asAna.body);
    expect((await world.owner('DELETE', '/api/v1/act-as')).statusCode).toBe(
      204,
    );
    const himself = await ask(world.owner, llm);
    for (const title of HIDDEN_TITLES) expect(himself.told).toContain(title);
  });

  it('AC-10: a CDC document in the sub-collection is found neither from the parent nor from the sub-collection', async () => {
    const { world, ana, llm } = await anaResearching(LOOKING);
    await placeDocuments(world, { 'hermetismo/aulas:raw/ci-2.md': 'cdc' });
    const fromParent = await ask(ana.call, llm);
    expect(fromParent.status, fromParent.body).toBe(200);
    expect(fromParent.told).not.toContain('Lua Media Duo');
    expect(fromParent.body).not.toContain('Lua Media Duo');
    expect(fromParent.told).toContain('Outros autores 3 ');
    const fromSub = await ask(ana.call, llm, 'hermetismo/aulas');
    expect(fromSub.status, fromSub.body).toBe(200);
    expect(fromSub.told).not.toContain('Lua Media Duo');
    expect(fromSub.body).not.toContain('Lua Media Duo');
  });
});
