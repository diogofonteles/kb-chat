import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Topic } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_VAULT } from '../test/fixture-paths.js';
import {
  OWNER_EMAIL,
  caller,
  closeApp,
  signIn,
  start,
  type Call,
  type Started,
} from '../test/ai-app-harness.js';

afterEach(closeApp);

const DOC = (title: string, body: string) =>
  `---\ntitle: ${title}\ntype: source\ngenre: reference_docs\ndepth: 2\nrelevance: collected_on_purpose\nauthor_group: outros-autores\n---\n\n${body}\n`;

/** A copy of the fixture vault with `udv` and its sub-topic `udv/palavra-do-mestre`. */
async function vaultWithSubTopic(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kbchat-vault-'));
  await cp(FIXTURE_VAULT, root, { recursive: true });
  const sub = join(root, 'udv', 'palavra-do-mestre');
  await mkdir(join(root, 'udv', 'raw'), { recursive: true });
  await mkdir(join(sub, 'raw'), { recursive: true });
  await writeFile(join(root, 'udv', 'topic.yaml'), 'title: UDV\n');
  await writeFile(join(sub, 'topic.yaml'), 'title: Palavra do Mestre\n');
  await writeFile(
    join(root, 'udv', 'raw', 'historia.md'),
    DOC('História do Centro', 'A história do centro e da burracheira.'),
  );
  await writeFile(
    join(sub, 'raw', 'sessao.md'),
    DOC('Sessão de Escala', 'Palavra sobre a burracheira na sessão.'),
  );
  return root;
}

const titles = (call: Call) =>
  call('GET', '/api/v1/topics').then((r) =>
    r.json().items.map((t: Topic) => [t.slug, t.parent, t.canOpen]),
  );

/** The owner, and Ana (a member) with the given features and collections. */
async function people(
  started: Started,
  ana: { features: string[]; topics: string[] },
) {
  const owner = caller(started.app, await signIn(started, OWNER_EMAIL));
  const invited = await owner('POST', '/api/v1/people', {
    email: 'ana@example.com',
  });
  const id: string = invited.json().id;
  await owner('PATCH', `/api/v1/people/${id}`, ana);
  const member = caller(started.app, await signIn(started, 'ana@example.com'));
  return { owner, member, memberId: id };
}

describe('Collections created on the screen (KBC-048, ADR 0028)', () => {
  it('AC-1, BR-5: whoever may create one sees it at once; it is kept in the state, not the vault', async () => {
    const started = await start();
    const { member } = await people(started, {
      features: ['search', 'collection-create'],
      topics: [],
    });
    const created = await member('POST', '/api/v1/topics', {
      title: 'União do Vegetal',
      description: 'Palestras e documentos',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      slug: 'uniao-do-vegetal',
      title: 'União do Vegetal',
      description: 'Palestras e documentos',
      parent: null,
      canOpen: true,
      canRename: true,
      documentCount: 0,
    });
    expect(await titles(member)).toEqual([['uniao-do-vegetal', null, true]]);
    const saved = JSON.parse(
      await readFile(join(started.state, 'collections.json'), 'utf8'),
    );
    expect(saved.collections[0]).toMatchObject({
      slug: 'uniao-do-vegetal',
      createdBy: 'ana@example.com',
    });
    // An empty collection searches without asking an index collection that does not exist.
    const search = await member(
      'POST',
      '/api/v1/topics/uniao-do-vegetal/searches',
      {
        q: 'qualquer coisa',
      },
    );
    expect(search.statusCode).toBe(200);
    expect(search.json().items).toEqual([]);
  });

  it('AC-2, AC-3: one level of sub-collections, shown under the parent', async () => {
    const started = await start();
    const owner = caller(started.app, await signIn(started, OWNER_EMAIL));
    await owner('POST', '/api/v1/topics', { title: 'Estudos' });
    const child = await owner('POST', '/api/v1/topics', {
      title: 'Caminho Pardo',
      parent: 'estudos',
    });
    expect(child.json()).toMatchObject({
      slug: 'estudos/caminho-pardo',
      parent: 'estudos',
    });
    const slugs = (await titles(owner)).map(([slug]: string[]) => slug);
    expect(slugs.indexOf('estudos/caminho-pardo')).toBe(
      slugs.indexOf('estudos') + 1,
    );
    const deeper = await owner('POST', '/api/v1/topics', {
      title: 'Mais fundo',
      parent: 'estudos/caminho-pardo',
    });
    expect(deeper.statusCode).toBe(400);
    const nowhere = await owner('POST', '/api/v1/topics', {
      title: 'Solto',
      parent: 'nao-existe',
    });
    expect(nowhere.statusCode).toBe(400);
  });

  it('AC-4: without "Criar acervos" creating and renaming are refused', async () => {
    const started = await start();
    const { member } = await people(started, {
      features: ['search', 'media-upload'],
      topics: ['hermetismo'],
    });
    expect(
      (await member('POST', '/api/v1/topics', { title: 'X' })).statusCode,
    ).toBe(403);
    expect(
      (await member('PATCH', '/api/v1/topics/hermetismo', { title: 'Y' }))
        .statusCode,
    ).toBe(403);
  });

  it('AC-5, BR-3: a sub-collection alone shows the parent as a closed group title', async () => {
    const started = await start({ vault: await vaultWithSubTopic() });
    const { member } = await people(started, {
      features: ['search'],
      topics: ['udv/palavra-do-mestre'],
    });
    expect(await titles(member)).toEqual([
      ['udv', null, false],
      ['udv/palavra-do-mestre', 'udv', true],
    ]);
    const parent = await member('POST', '/api/v1/topics/udv/searches', {
      q: 'burracheira',
    });
    expect(parent.statusCode).toBe(404);
    const child = await member(
      'POST',
      `/api/v1/topics/${encodeURIComponent('udv/palavra-do-mestre')}/searches`,
      { q: 'burracheira' },
    );
    expect(child.json().items.map((hit: { id: string }) => hit.id)).toEqual([
      'raw/sessao.md',
    ]);
  });

  it('FR-4, BR-3: the parent searches like a folder and each result keeps its collection', async () => {
    const started = await start({ vault: await vaultWithSubTopic() });
    const { member } = await people(started, {
      features: ['search'],
      topics: ['udv'],
    });
    const list = (await member('GET', '/api/v1/topics')).json().items;
    expect(list.find((t: Topic) => t.slug === 'udv').documentCount).toBe(2);
    const found = await member('POST', '/api/v1/topics/udv/searches', {
      q: 'burracheira',
    });
    expect(
      found
        .json()
        .items.map((hit: { topic: string; id: string }) => [hit.topic, hit.id])
        .sort(),
    ).toEqual([
      ['udv', 'raw/historia.md'],
      ['udv/palavra-do-mestre', 'raw/sessao.md'],
    ]);
    const opened = await member(
      'GET',
      `/api/v1/topics/${encodeURIComponent('udv/palavra-do-mestre')}/documents/${encodeURIComponent('raw/sessao.md')}`,
    );
    expect(opened.statusCode).toBe(200);
    const facets = await member('GET', '/api/v1/topics/udv/facets');
    expect(facets.statusCode).toBe(200);
  });

  it('AC-6, BR-4: renaming keeps the slug and who may see it, the vault untouched', async () => {
    const vault = await vaultWithSubTopic();
    const started = await start({ vault });
    const { owner, member } = await people(started, {
      features: ['search'],
      topics: ['udv'],
    });
    const renamed = await owner('PATCH', '/api/v1/topics/udv', {
      title: 'União do Vegetal',
    });
    expect(renamed.json()).toMatchObject({
      slug: 'udv',
      title: 'União do Vegetal',
      documentCount: 2,
    });
    const seen = (await member('GET', '/api/v1/topics')).json().items;
    expect(seen.map((t: Topic) => t.title)).toContain('União do Vegetal');
    expect(await readFile(join(vault, 'udv', 'topic.yaml'), 'utf8')).toBe(
      'title: UDV\n',
    );
  });

  it('AC-7, NFR-2: a name that becomes a slug already taken is refused and nothing changes', async () => {
    const started = await start({ vault: await vaultWithSubTopic() });
    const owner = caller(started.app, await signIn(started, OWNER_EMAIL));
    const again = await owner('POST', '/api/v1/topics', { title: 'Udv' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('TOPIC_EXISTS');
    await owner('POST', '/api/v1/topics', { title: 'Novo' });
    const twice = await owner('POST', '/api/v1/topics', { title: 'NOVO!' });
    expect(twice.statusCode).toBe(409);
    const saved = JSON.parse(
      await readFile(join(started.state, 'collections.json'), 'utf8'),
    );
    expect(saved.collections.map((c: { slug: string }) => c.slug)).toEqual([
      'novo',
    ]);
    const blank = await owner('POST', '/api/v1/topics', { title: '!!!' });
    expect(blank.statusCode).toBe(400);
  });
});

/** The fixture vault plus a folder that only groups topics: `harness/goclaw`. */
async function vaultWithGroupingFolder(): Promise<string> {
  const root = await vaultWithSubTopic();
  await mkdir(join(root, 'harness', 'goclaw', 'raw'), { recursive: true });
  await writeFile(
    join(root, 'harness', 'goclaw', 'topic.yaml'),
    'title: Goclaw\n',
  );
  await writeFile(
    join(root, 'harness', 'goclaw', 'raw', 'nota.md'),
    DOC('Nota', 'Uma nota sobre a burracheira.'),
  );
  return root;
}

describe('Collections: review and QA fixes (KBC-048)', () => {
  it('a name over a vault folder that groups topics is taken, so it never becomes their parent', async () => {
    const started = await start({ vault: await vaultWithGroupingFolder() });
    const { member } = await people(started, {
      features: ['search', 'collection-create'],
      topics: [],
    });
    const taken = await member('POST', '/api/v1/topics', { title: 'Harness' });
    expect(taken.statusCode).toBe(409);
    expect(await titles(member)).toEqual([]);
  });

  it('two collections created at once both stay', async () => {
    const started = await start();
    const owner = caller(started.app, await signIn(started, OWNER_EMAIL));
    const made = await Promise.all(
      ['Primeiro', 'Segundo', 'Terceiro'].map((title) =>
        owner('POST', '/api/v1/topics', { title }),
      ),
    );
    expect(made.map((r) => r.statusCode)).toEqual([201, 201, 201]);
    const slugs = (await titles(owner)).map(([slug]: string[]) => slug);
    expect(slugs).toEqual(
      expect.arrayContaining(['primeiro', 'segundo', 'terceiro']),
    );
  });

  it('two collections side by side never share a name, created or renamed', async () => {
    const started = await start();
    const owner = caller(started.app, await signIn(started, OWNER_EMAIL));
    await owner('POST', '/api/v1/topics', { title: 'Hinos' });
    await owner('POST', '/api/v1/topics', { title: 'Outros' });
    const renamed = await owner('PATCH', '/api/v1/topics/outros', {
      title: 'hinos!',
    });
    expect(renamed.statusCode).toBe(409);
    // The same name under another parent is fine.
    const inside = await owner('POST', '/api/v1/topics', {
      title: 'Hinos',
      parent: 'outros',
    });
    expect(inside.statusCode).toBe(201);
  });

  it('S-1: a member renames only what they created; a master renames any', async () => {
    const started = await start();
    const { owner, member } = await people(started, {
      features: ['search', 'collection-create'],
      topics: ['hermetismo'],
    });
    await member('POST', '/api/v1/topics', { title: 'Meu' });
    expect(
      (await member('PATCH', '/api/v1/topics/meu', { title: 'Meu acervo' }))
        .statusCode,
    ).toBe(200);
    expect(
      (await member('PATCH', '/api/v1/topics/hermetismo', { title: 'X' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await owner('PATCH', '/api/v1/topics/meu', { description: 'ok' }))
        .statusCode,
    ).toBe(200);
    // The list says which ones the person may rename, so the screen offers only those.
    const listed = (await member('GET', '/api/v1/topics')).json().items;
    expect(listed.map((t: Topic) => [t.slug, t.canRename]).sort()).toEqual([
      ['hermetismo', false],
      ['meu', true],
    ]);
  });

  it('FR-4: the "Sub-acervo" filter restricts a parent to some of its collections, with counts', async () => {
    const started = await start({ vault: await vaultWithSubTopic() });
    const owner = caller(started.app, await signIn(started, OWNER_EMAIL));
    const all = (
      await owner('POST', '/api/v1/topics/udv/searches', { q: 'burracheira' })
    ).json();
    expect(all.facets.topics).toEqual(
      expect.arrayContaining([
        { value: 'udv', count: 1 },
        { value: 'udv/palavra-do-mestre', count: 1 },
      ]),
    );
    const own = await owner('POST', '/api/v1/topics/udv/searches', {
      q: 'burracheira',
      filters: { topics: ['udv'] },
    });
    expect(own.json().items.map((hit: { id: string }) => hit.id)).toEqual([
      'raw/historia.md',
    ]);
    const facets = (await owner('GET', '/api/v1/topics/udv/facets')).json();
    expect(facets.topics).toHaveLength(2);
  });

  it('a master acting as a person creates for the person, and the records name the master', async () => {
    const started = await start();
    const { owner, member, memberId } = await people(started, {
      features: ['search', 'collection-create'],
      topics: [],
    });
    await owner('POST', `/api/v1/people/${memberId}/act-as`, {
      reason: 'criar o acervo dela',
    });
    const made = await owner('POST', '/api/v1/topics', { title: 'Dela' });
    expect(made.statusCode).toBe(201);
    await owner('DELETE', '/api/v1/act-as');
    expect(await titles(member)).toEqual([['dela', null, true]]);
    const saved = JSON.parse(
      await readFile(join(started.state, 'collections.json'), 'utf8'),
    );
    expect(saved.collections[0]).toMatchObject({
      createdBy: OWNER_EMAIL,
      createdFor: 'ana@example.com',
    });
    // Created for her, so she may rename it herself.
    expect(
      (await member('PATCH', '/api/v1/topics/dela', { title: 'Minha' }))
        .statusCode,
    ).toBe(200);
    const audit = (await owner('GET', '/api/v1/act-as/audit')).json().items;
    expect(
      audit.some(
        (e: { kind: string; method?: string; route?: string }) =>
          e.kind === 'write' &&
          e.method === 'POST' &&
          e.route === '/api/v1/topics',
      ),
    ).toBe(true);
  });
});
