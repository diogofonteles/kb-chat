import type { SearchResponse, Topic } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import { queuedItem } from '../test/media-harness.js';
import {
  HIDDEN_TITLES,
  SIX,
  createScale,
  doc,
  memberOf,
  placeDocuments,
  search,
  setPersonLevel,
  sixAtThreeLevels,
  startLevels,
  titlesOf,
  writeDocs,
} from '../test/levels-world.js';

afterEach(closeApp);

const OPEN = [
  'Lua Media Duo',
  'Lua Media Uno',
  'Lua Primeira Aberta',
  'Lua Segunda Aberta',
];
const ALL = [...OPEN, ...HIDDEN_TITLES].sort();

const expectNoHidden = (body: string) => {
  for (const title of HIDDEN_TITLES) expect(body).not.toContain(title);
  expect(body).not.toContain('cdc-');
};

/** Ana at CI over the six documents at QS, CI and CDC. */
async function anaAtCi(options: { readonly media?: boolean } = {}) {
  const world = await startLevels(SIX, options);
  const ana = await memberOf(world, 'ana@example.com');
  await sixAtThreeLevels(world);
  await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
  return { world, ana };
}

describe('Search and reading within the person level (KBC-103, ADR 0036 §7)', () => {
  it('AC-2, FR-6: a CI member finds only QS and CI, counted as 4, with no CDC title anywhere', async () => {
    const { ana } = await anaAtCi();
    const found = await search(ana.call, 'lua');
    expect(found.statusCode).toBe(200);
    const body = found.json<SearchResponse>();
    expect(titlesOf(body)).toEqual(OPEN);
    expect(body.total).toBe(4);
    expect(body.kinds.text).toBe(4);
    expect(body.facets.genres).toEqual([{ value: 'reference_docs', count: 4 }]);
    expect(body.items.every((item) => item.level === undefined)).toBe(true);
    expectNoHidden(found.body);
  });

  it('AC-3, BR-8: a copy at CDC is neither counted nor named in a CI member result', async () => {
    const world = await startLevels([
      ...SIX,
      doc('hermetismo/raw/tabua-a.md', 'Tábua de Esmeralda', 'A lua da tábua.'),
      doc('hermetismo/raw/tabua-b.md', 'Tábua de Esmeralda', 'A lua na cópia.'),
    ]);
    const ana = await memberOf(world, 'ana@example.com');
    await sixAtThreeLevels(world);
    await placeDocuments(world, { 'hermetismo:raw/tabua-b.md': 'cdc' });
    await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
    const found = await search(ana.call, 'tábua');
    const tabua = found
      .json<SearchResponse>()
      .items.find((item) => item.title === 'Tábua de Esmeralda');
    expect(tabua?.id).toBe('raw/tabua-a.md');
    expect(tabua?.copies).toEqual([]);
    expect(found.body).not.toContain('tabua-b');
    const owner = await search(world.owner, 'tábua');
    expect(owner.json<SearchResponse>().items[0]?.copies).toHaveLength(1);
  });

  it('AC-4, BR-7: a CDC document answers 404 like one that does not exist', async () => {
    const { world, ana } = await anaAtCi();
    const hidden = await ana.call(
      'GET',
      '/api/v1/topics/hermetismo/documents/raw%2Fcdc-1.md',
    );
    const missing = await ana.call(
      'GET',
      '/api/v1/topics/hermetismo/documents/raw%2Fnone.md',
    );
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual(missing.json());
    expect(hidden.json().error.code).toBe('DOCUMENT_NOT_FOUND');
    const relations = await ana.call(
      'GET',
      '/api/v1/topics/hermetismo/documents/raw%2Fcdc-1.md/relations/related',
    );
    expect(relations.statusCode).toBe(404);
    const owner = await world.owner(
      'GET',
      '/api/v1/topics/hermetismo/documents/raw%2Fcdc-1.md',
    );
    expect(owner.json().level).toEqual({ id: 'cdc', code: 'CDC' });
  });

  it('AC-5, BR-8: "Veja também" and the relation page leave out a linked CDC document', async () => {
    const world = await startLevels([
      ...SIX,
      doc('hermetismo/raw/ligado.md', 'Texto Ligado', {
        body: 'Um texto do meio.',
        extra: 'related: ["[[Segredo]]", "[[Aberto]]"]',
      }),
      doc('hermetismo/wiki/concepts/Segredo.md', 'Segredo', 'Conceito velado.'),
      doc('hermetismo/wiki/concepts/Aberto.md', 'Aberto', 'Conceito aberto.'),
    ]);
    const ana = await memberOf(world, 'ana@example.com');
    await sixAtThreeLevels(world);
    await placeDocuments(world, {
      'hermetismo:raw/ligado.md': 'ci',
      'hermetismo:wiki/concepts/Segredo.md': 'cdc',
    });
    await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
    const opened = await ana.call(
      'GET',
      '/api/v1/topics/hermetismo/documents/raw%2Fligado.md',
    );
    expect(opened.statusCode).toBe(200);
    expect(opened.json().seeAlso.related).toEqual({
      items: [expect.objectContaining({ title: 'Aberto' })],
      total: 1,
    });
    expect(opened.body).not.toContain('Segredo');
    const page = await ana.call(
      'GET',
      '/api/v1/topics/hermetismo/documents/raw%2Fligado.md/relations/related',
    );
    expect(page.json()).toMatchObject({ total: 1, nextOffset: null });
    expect(page.body).not.toContain('Segredo');
    const master = await world.owner(
      'GET',
      '/api/v1/topics/hermetismo/documents/raw%2Fligado.md',
    );
    expect(master.json().seeAlso.related.total).toBe(2);
  });

  it('AC-6, BR-8: the collection list, the facets and the suggestions count only what she sees', async () => {
    const world = await startLevels();
    const ana = await memberOf(world, 'ana@example.com');
    await createScale(world, ['QS', 'CI', 'CDC']);
    await placeDocuments(world, {
      'hermetismo:raw/ci-1.md': 'cdc',
      'hermetismo/aulas:raw/ci-2.md': 'cdc',
      'hermetismo:raw/cdc-1.md': 'cdc',
      'hermetismo:raw/cdc-2.md': 'cdc',
    });
    const topics = await ana.call('GET', '/api/v1/topics');
    const counts = Object.fromEntries(
      topics
        .json()
        .items.map((topic: Topic) => [topic.slug, topic.documentCount]),
    );
    expect(counts).toEqual({ hermetismo: 2, 'hermetismo/aulas': 0 });
    const facets = await ana.call('GET', '/api/v1/topics/hermetismo/facets');
    expect(facets.json().genres).toEqual([
      { value: 'reference_docs', count: 2 },
    ]);
    expect(facets.json().concepts).toEqual([
      expect.objectContaining({ value: 'Astrologia', count: 2 }),
    ]);
    const suggestions = await ana.call(
      'GET',
      '/api/v1/topics/hermetismo/suggestions',
    );
    expect(JSON.stringify(suggestions.json())).not.toMatch(/\b6\b|\b4\b/);
    const ownerTopics = await world.owner('GET', '/api/v1/topics');
    expect(
      ownerTopics
        .json()
        .items.find((topic: Topic) => topic.slug === 'hermetismo')
        .documentCount,
    ).toBe(6);
  });

  it('AC-7, NFR-3: a member without a level sees as the lowest, and a raise applies on the next search', async () => {
    const world = await startLevels();
    await sixAtThreeLevels(world);
    const bia = await memberOf(world, 'bia@example.com');
    expect(titlesOf((await search(bia.call, 'lua')).json())).toEqual([
      'Lua Primeira Aberta',
      'Lua Segunda Aberta',
    ]);
    await setPersonLevel(world, bia.id, { hermetismo: 'cdc' });
    expect(titlesOf((await search(bia.call, 'lua')).json())).toEqual(ALL);
    const me = await bia.call('GET', '/api/v1/me');
    expect(me.json()).toMatchObject({
      levels: { hermetismo: 'CDC' },
      levelsManager: false,
    });
  });

  it('AC-8, BR-5: the master sees all six, and as Ana sees her four', async () => {
    const { world, ana } = await anaAtCi();
    const own = await search(world.owner, 'lua');
    expect(titlesOf(own.json())).toEqual(ALL);
    expect(
      own
        .json<SearchResponse>()
        .items.find((item) => item.id === 'raw/cdc-1.md')?.level,
    ).toEqual({ id: 'cdc', code: 'CDC' });
    const me = await world.owner('GET', '/api/v1/me');
    expect(me.json()).toMatchObject({ levels: {}, levelsManager: true });
    const acting = await world.owner(
      'POST',
      `/api/v1/people/${ana.id}/act-as`,
      {
        reason: 'Conferir os níveis de Ana',
      },
    );
    expect(acting.statusCode, acting.body).toBe(200);
    const asAna = await search(world.owner, 'lua');
    expect(titlesOf(asAna.json())).toEqual(OPEN);
    expectNoHidden(asAna.body);
  });

  it('AC-9, BR-6: a new vault document without a level is for masters only, counted on T24', async () => {
    const { world, ana } = await anaAtCi();
    await writeDocs(world.vault, [
      doc('hermetismo/raw/novo.md', 'Lua Recém Chegada', 'A lua nova do kb.'),
    ]);
    await world.started.catalog.refresh('hermetismo');
    expect(titlesOf((await search(ana.call, 'lua')).json())).toEqual(OPEN);
    const own = await search(world.owner, 'lua');
    const fresh = own
      .json<SearchResponse>()
      .items.find((item) => item.title === 'Lua Recém Chegada');
    expect(fresh?.level).toBeNull();
    const levels = await world.owner('GET', '/api/v1/topics/hermetismo/levels');
    expect(levels.json().unassigned).toBe(1);
  });

  it('AC-10, BR-1: her level in the parent applies in the sub-collection, searched alone or from the parent', async () => {
    const world = await startLevels([
      ...SIX,
      doc(
        'hermetismo/aulas/raw/aula-cdc.md',
        'Aula Velada',
        'A lua da aula velada.',
      ),
    ]);
    const ana = await memberOf(world, 'ana@example.com', {
      topics: ['hermetismo'],
    });
    await sixAtThreeLevels(world);
    await placeDocuments(world, { 'hermetismo/aulas:raw/aula-cdc.md': 'cdc' });
    await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
    const sub = await search(ana.call, 'lua', 'hermetismo/aulas');
    expect(titlesOf(sub.json())).toEqual(['Lua Media Duo']);
    const parent = await search(ana.call, 'lua');
    expect(parent.body).not.toContain('Aula Velada');
  });

  it('AC-14, BR-10: AI research and the media of a collection with levels are closed to members, open to masters', async () => {
    const { world, ana } = await anaAtCi({ media: true });
    const item = await queuedItem(
      {
        started: world.started,
        owner: world.owner,
        ownerHeaders: world.ownerHeaders,
        mediaDir: '',
      },
      'hermetismo',
      { author: null },
    );
    const research = await ana.call(
      'POST',
      '/api/v1/topics/hermetismo/research',
      {
        question: 'o que dizem sobre a lua?',
      },
    );
    expect(research.statusCode).toBe(409);
    expect(research.json().error.code).toBe('LEVELS_PENDING');
    expect((await ana.call('GET', `/api/v1/media/${item.id}`)).statusCode).toBe(
      404,
    );
    const list = await ana.call('GET', '/api/v1/topics/hermetismo/media');
    expect(list.body).not.toContain(item.id);
    const master = await world.owner('GET', `/api/v1/media/${item.id}`);
    expect(master.statusCode).toBe(200);
    const ownerResearch = await world.owner(
      'POST',
      '/api/v1/topics/hermetismo/research',
      { question: 'o que dizem sobre a lua?' },
    );
    expect(ownerResearch.json()?.error?.code).not.toBe('LEVELS_PENDING');
  });

  it('AC-15: a collection without levels keeps every result for a member', async () => {
    const world = await startLevels();
    const ana = await memberOf(world, 'ana@example.com');
    await createScale(world, ['QS'], 'alquimia');
    expect(titlesOf((await search(ana.call, 'lua')).json())).toEqual(ALL);
  });

  it('AC-16: with 50 of 1,000 documents visible, the index is asked deeper and all 12 matches come back', async () => {
    const name = (n: number) => `raw/d-${String(n).padStart(4, '0')}.md`;
    const visible = (n: number) => n % 20 === 0;
    const docs = Array.from({ length: 1000 }, (_, n) =>
      doc(
        `hermetismo/${name(n)}`,
        `Documento ${n}`,
        !visible(n) || n < 240 ? 'termo comum' : 'comum',
      ),
    );
    const world = await startLevels(docs);
    const ana = await memberOf(world, 'ana@example.com');
    // Everything starts at CI; QS enters above it and is then moved to the bottom.
    await createScale(world, ['CI', 'QS']);
    const moved = await world.owner(
      'PATCH',
      '/api/v1/topics/hermetismo/levels',
      {
        order: ['qs', 'ci'],
      },
    );
    expect(moved.statusCode).toBe(200);
    const open: Record<string, string> = {};
    for (let n = 0; n < 1000; n += 20) open[`hermetismo:${name(n)}`] = 'qs';
    await placeDocuments(world, open);
    // The first level (CI) placed her too; she goes down to QS.
    await setPersonLevel(world, ana.id, { hermetismo: 'qs' });
    const all = await search(ana.call, 'comum');
    expect(all.json<SearchResponse>().total).toBe(50);
    const term = await search(ana.call, 'termo');
    expect(term.json<SearchResponse>().total).toBe(12);
  }, 120_000);

  it('QA-1, QA-4, BR-10: a member can neither check nor send a file to media closed by levels, and nothing names it', async () => {
    const world = await startLevels(SIX, { media: true });
    const ana = await memberOf(world, 'ana@example.com', {
      features: ['search', 'media', 'media-upload'],
    });
    await sixAtThreeLevels(world);
    await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
    const sha256 = 'a'.repeat(64);
    // Created (not sent): the check and the create read the hash the item was created with.
    const created = await world.owner(
      'POST',
      '/api/v1/topics/hermetismo/media',
      {
        title: 'Gravação Secreta do Mestre',
        author: null,
        fileName: 'secreta.mp3',
        bytes: 10,
        sha256,
      },
    );
    expect(created.statusCode, created.body).toBe(201);
    const item: { id: string } = created.json();
    const check = await ana.call(
      'POST',
      '/api/v1/topics/hermetismo/media/check',
      {
        sha256,
        bytes: 10,
        durationMs: null,
      },
    );
    expect(check.statusCode).toBe(409);
    expect(check.json().error.code).toBe('LEVELS_PENDING');
    const sent = await ana.call('POST', '/api/v1/topics/hermetismo/media', {
      title: 'Outra',
      author: null,
      fileName: 'outra.mp3',
      bytes: 10,
      sha256,
    });
    expect(sent.statusCode).toBe(409);
    expect(sent.json().error.code).toBe('LEVELS_PENDING');
    const fresh = await ana.call('POST', '/api/v1/topics/hermetismo/media', {
      title: 'Nova',
      author: null,
      fileName: 'nova.mp3',
      bytes: 10,
    });
    expect(fresh.statusCode).toBe(409);
    for (const body of [check.body, sent.body, fresh.body]) {
      expect(body).not.toContain(item.id);
      expect(body).not.toContain('Gravação Secreta');
    }
    const master = await world.owner(
      'POST',
      '/api/v1/topics/hermetismo/media/check',
      {
        sha256,
        bytes: 10,
        durationMs: null,
      },
    );
    // The master still checks there (the file is his, still uploading: "resume").
    expect(master.statusCode).toBe(200);
    expect(master.json().media.id).toBe(item.id);
  });

  it('QA-2, BR-8: the subjects and speakers of media closed by levels stay closed, with no name and no 409 oracle', async () => {
    const world = await startLevels(
      [
        ...SIX,
        doc(
          'hermetismo/wiki/concepts/Segredo.md',
          'Segredo',
          'Conceito velado.',
        ),
      ],
      { media: true },
    );
    const ana = await memberOf(world, 'ana@example.com', {
      features: ['search', 'media', 'media-classify', 'media-edit'],
    });
    await sixAtThreeLevels(world);
    await placeDocuments(world, {
      'hermetismo:wiki/concepts/Segredo.md': 'cdc',
    });
    await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
    const listed = await ana.call('GET', '/api/v1/topics/hermetismo/subjects');
    expect(listed.statusCode).toBe(409);
    expect(listed.body).not.toContain('Segredo');
    const known = await ana.call('POST', '/api/v1/topics/hermetismo/subjects', {
      name: 'Segredo',
    });
    const unknown = await ana.call(
      'POST',
      '/api/v1/topics/hermetismo/subjects',
      {
        name: 'Inédito',
      },
    );
    expect(known.statusCode).toBe(409);
    expect(unknown.statusCode).toBe(409);
    expect(known.json()).toEqual(unknown.json());
    const speakers = await ana.call(
      'GET',
      '/api/v1/topics/hermetismo/speakers',
    );
    expect(speakers.statusCode).toBe(409);
    const master = await world.owner(
      'GET',
      '/api/v1/topics/hermetismo/subjects',
    );
    expect(master.json().concepts).toContain('Segredo');
  });
});
