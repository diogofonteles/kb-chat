import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Topic } from '@kb-chat/contracts';
import type { FastifyInstance } from 'fastify';
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
import { signedInApp } from '../test/auth-factories.js';
import { aRequest } from '../test/media-harness.js';
import { FsVaultAdapter } from './adapters/fs-vault-adapter.js';
import { MemorySpendLedger } from './adapters/memory-spend-ledger.js';
import { StubLlmAdapter } from './adapters/stub-llm-adapter.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import {
  CollectionRegistry,
  CollectionsVault,
} from './modules/topics/index.js';
import { MemoryDocumentStore } from './adapters/memory-document-store.js';
import { createSearchIndex } from './search-index-factory.js';
import { createResearchAgent } from './research-agent-factory.js';
import { AuthorDirectory, AuthorsService } from './modules/authors/index.js';
import { CatalogRegistry } from './modules/catalog/index.js';

afterEach(closeApp);

const DOC = (title: string) =>
  `---\ntitle: ${title}\ntype: source\nauthor_group: outros-autores\n---\n\nTexto sobre a burracheira.\n`;

/** A copy of the fixture vault with `udv` and its sub-collection `udv/palavra-do-mestre`. */
async function vaultWithUdv(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kbchat-vault-'));
  await cp(FIXTURE_VAULT, root, { recursive: true });
  const sub = join(root, 'udv', 'palavra-do-mestre');
  await mkdir(join(root, 'udv', 'raw'), { recursive: true });
  await mkdir(join(sub, 'raw'), { recursive: true });
  await writeFile(join(root, 'udv', 'topic.yaml'), 'title: UDV\n');
  await writeFile(join(sub, 'topic.yaml'), 'title: Palavra do Mestre\n');
  await writeFile(join(root, 'udv', 'raw', 'historia.md'), DOC('História'));
  await writeFile(join(sub, 'raw', 'sessao.md'), DOC('Sessão'));
  return root;
}

/** The owner, and Ana with the given features in the UDV. */
async function withAna(started: Started, features: string[]) {
  const owner = caller(started.app, await signIn(started, OWNER_EMAIL));
  const invited = await owner('POST', '/api/v1/people', {
    email: 'ana@example.com',
    sendEmail: false,
  });
  await owner('PATCH', `/api/v1/people/${invited.json().id}`, {
    topics: ['udv'],
    features,
  });
  const ana = caller(started.app, await signIn(started, 'ana@example.com'));
  return { owner, ana };
}

/** The sub-collection in a URL: its slug's slash is encoded. */
const SUB = encodeURIComponent('udv/palavra-do-mestre');
const UPLOADER = ['media', 'media-upload'];
const gabriel = { slug: 'mestre-gabriel', name: 'Mestre Gabriel' };

async function startUdv(features = UPLOADER) {
  const started = await start({ media: true, vault: await vaultWithUdv() });
  return { started, ...(await withAna(started, features)) };
}

const topicOf = async (call: Call, slug: string): Promise<Topic | undefined> =>
  (await call('GET', '/api/v1/topics'))
    .json()
    .items.find((one: Topic) => one.slug === slug);

describe('authors per collection (KBC-049)', () => {
  it('AC-1, FR-1: an uploader registers "Mestre Gabriel" and the audio carries his name', async () => {
    const { ana } = await startUdv();

    const empty = await ana('GET', '/api/v1/topics/udv/authors');
    const created = await ana('POST', '/api/v1/topics/udv/authors', {
      name: ' Mestre Gabriel ',
    });
    const again = await ana('POST', '/api/v1/topics/udv/authors', {
      name: 'mestre gabriel',
    });
    const media = await ana(
      'POST',
      '/api/v1/topics/udv/media',
      aRequest({ author: 'mestre-gabriel' }),
    );

    expect(empty.json()).toEqual({ items: [] });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ ...gabriel, main: false });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(created.json());
    expect(media.statusCode).toBe(201);
    expect(media.json().author).toEqual({ ...gabriel, main: false });
  });

  it('refuses media by an author the collection does not have, and keeps media with no author', async () => {
    const { ana } = await startUdv();

    const unknown = await ana(
      'POST',
      '/api/v1/topics/udv/media',
      aRequest({ author: 'mestre-gabriel' }),
    );
    const none = await ana(
      'POST',
      '/api/v1/topics/udv/media',
      aRequest({ author: null }),
    );

    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.details).toEqual({ field: 'author' });
    expect(none.json().author).toBeNull();
  });

  it("AC-3, BR-1: a sub-collection suggests and keeps its parent's authors", async () => {
    const { ana } = await startUdv();
    await ana('POST', `/api/v1/topics/${SUB}/authors`, {
      name: 'Mestre Gabriel',
    });

    const parent = await ana('GET', '/api/v1/topics/udv/authors');
    const child = await ana('GET', `/api/v1/topics/${SUB}/authors`);
    const media = await ana(
      'POST',
      `/api/v1/topics/${SUB}/media`,
      aRequest({ author: 'mestre-gabriel' }),
    );

    expect(parent.json().items).toEqual([{ ...gabriel, main: false }]);
    expect(child.json()).toEqual(parent.json());
    expect(media.json().author.name).toBe('Mestre Gabriel');
  });

  it('AC-4, BR-3: registering needs the upload permission there; reading needs the collection', async () => {
    const { ana, started } = await startUdv(['media']);

    const refused = await ana('POST', '/api/v1/topics/udv/authors', {
      name: 'Mestre Gabriel',
    });
    const listed = await ana('GET', '/api/v1/topics/udv/authors');
    const elsewhere = await ana('GET', '/api/v1/topics/alquimia/authors');
    const blank = await caller(started.app, await signIn(started, OWNER_EMAIL))(
      'POST',
      '/api/v1/topics/udv/authors',
      { name: '  ' },
    );

    expect(refused.statusCode).toBe(403);
    expect(listed.statusCode).toBe(200);
    expect(elsewhere.statusCode).toBe(404);
    expect(blank.statusCode).toBe(400);
  });

  it('FR-2, BR-2: PATCH chooses the main author; the list, the topic and the media show it', async () => {
    const { owner, ana } = await startUdv();
    await ana('POST', '/api/v1/topics/udv/authors', { name: 'Mestre Gabriel' });
    await ana('POST', '/api/v1/topics/udv/authors', { name: 'Outro Autor' });
    await ana(
      'POST',
      `/api/v1/topics/${SUB}/media`,
      aRequest({ author: 'mestre-gabriel' }),
    );

    const patched = await owner('PATCH', '/api/v1/topics/udv', {
      mainAuthor: 'mestre-gabriel',
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ slug: 'udv', mainAuthor: gabriel });
    expect((await topicOf(ana, 'udv/palavra-do-mestre'))?.mainAuthor).toEqual(
      gabriel,
    );
    const authors = await ana('GET', '/api/v1/topics/udv/authors');
    expect(authors.json().items[0]).toEqual({ ...gabriel, main: true });
    const media = await ana('GET', `/api/v1/topics/${SUB}/media`);
    expect(media.json().items[0].author).toEqual({ ...gabriel, main: true });
  });

  it('FR-2: refuses a main author that is not in the list, on a sub-collection, or by someone who may not rename', async () => {
    const { owner, ana } = await startUdv([...UPLOADER, 'collection-create']);
    await ana('POST', '/api/v1/topics/udv/authors', { name: 'Mestre Gabriel' });

    const unknown = await owner('PATCH', '/api/v1/topics/udv', {
      mainAuthor: 'ninguem',
    });
    const sub = await owner('PATCH', `/api/v1/topics/${SUB}`, {
      mainAuthor: 'mestre-gabriel',
    });
    const notCreator = await ana('PATCH', '/api/v1/topics/udv', {
      mainAuthor: 'mestre-gabriel',
    });
    const cleared = await owner('PATCH', '/api/v1/topics/udv', {
      mainAuthor: null,
    });

    expect(unknown.statusCode).toBe(400);
    expect(sub.statusCode).toBe(400);
    expect(notCreator.statusCode).toBe(403);
    expect(cleared.json().mainAuthor).toBeNull();
  });

  it("writes the old column's Mestre only for his own id, never for another main author (ADR 0030 §4)", async () => {
    const { started, owner, ana } = await startUdv();
    await ana('POST', '/api/v1/topics/udv/authors', { name: 'Mestre Gabriel' });
    await owner('PATCH', '/api/v1/topics/udv', {
      mainAuthor: 'mestre-gabriel',
    });
    const media = await ana(
      'POST',
      '/api/v1/topics/udv/media',
      aRequest({ author: 'mestre-gabriel' }),
    );

    const db = new DatabaseSync(join(started.state, 'media', 'media.db'), {
      readOnly: true,
    });
    const row = db
      .prepare('SELECT author, authorship FROM media WHERE id = ?')
      .get(media.json().id);
    db.close();

    expect({ ...row }).toEqual({
      author: 'mestre-gabriel',
      authorship: 'outros-autores',
    });
  });

  it('PATCH changes nothing when one of its parts is refused (all or nothing)', async () => {
    const { owner, ana } = await startUdv();
    await ana('POST', '/api/v1/topics/udv/authors', { name: 'Mestre Gabriel' });

    const unknown = await owner('PATCH', '/api/v1/topics/udv', {
      title: 'Outro nome',
      mainAuthor: 'ninguem',
    });
    const taken = await owner('PATCH', '/api/v1/topics/udv', {
      title: 'Alquimia Prática',
      mainAuthor: 'mestre-gabriel',
    });

    expect(unknown.statusCode).toBe(400);
    expect(taken.statusCode).toBe(409);
    expect(await topicOf(owner, 'udv')).toMatchObject({
      title: 'UDV',
      mainAuthor: null,
    });
  });

  it('AC-5, BR-4: the Hermetismo keeps "Mestre Laércio" as main author, in the file and after a restart', async () => {
    const started = await start({ media: true });
    const owner = caller(started.app, await signIn(started, OWNER_EMAIL));
    const legacy = await owner(
      'POST',
      '/api/v1/topics/hermetismo/media',
      aRequest({ author: 'mestre-laercio' }),
    );
    const other = await owner(
      'POST',
      '/api/v1/topics/hermetismo/media',
      aRequest({ author: null }),
    );
    await owner('PATCH', '/api/v1/topics/hermetismo', { mainAuthor: null });

    expect(legacy.json().author).toEqual({
      slug: 'mestre-laercio',
      name: 'Mestre Laércio',
      main: true,
    });
    expect(other.json().author).toBeNull();
    const file = JSON.parse(
      await readFile(join(started.state, 'authors.json'), 'utf8'),
    );
    expect(file.collections.hermetismo.main).toBeNull();

    await closeApp();
    const restarted = await start({ media: true, state: started.state });
    const again = caller(restarted.app, await signIn(restarted, OWNER_EMAIL));
    // A choice made after the seed is never undone by the next start.
    expect((await topicOf(again, 'hermetismo'))?.mainAuthor).toBeNull();
  });
});

describe('the research rule follows the main author (KBC-049 AC-2)', () => {
  const HOST: Record<string, string> = { host: 'localhost' };
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("never names another collection's master: the UDV's turns name Mestre Gabriel", async () => {
    const config = loadConfig({
      KB_VAULT: await vaultWithUdv(),
      KB_CHAT_SEARCH: 'fixture',
      LOG_LEVEL: 'silent',
    });
    const collections = new CollectionRegistry(new MemoryDocumentStore());
    const vault = new CollectionsVault(
      new FsVaultAdapter(config.KB_VAULT),
      collections,
    );
    const index = await createSearchIndex({
      config,
      vault,
      log: createLogger('silent'),
    });
    const llm = new StubLlmAdapter();
    // Composed as main does: the agent names each collection's main author (ADR 0030).
    const catalog = new CatalogRegistry(vault);
    await catalog.load();
    const authorDirectory = new AuthorDirectory(new MemoryDocumentStore());
    const authors = new AuthorsService({ directory: authorDirectory, catalog });
    const ledger = new MemorySpendLedger();
    const agent = createResearchAgent({
      catalog,
      index,
      vault,
      ledger,
      mainAuthorOf: (topic) => authors.mainVoiceOf(topic),
    });
    app = await signedInApp(HOST)({
      config,
      vault,
      collections,
      catalog,
      authorDirectory,
      agent,
      index,
      llm,
      ledger,
      logger: createLogger('silent'),
    });
    const call = (method: 'POST' | 'PATCH', url: string, payload: object) =>
      app?.inject({ method, url, headers: HOST, payload });
    await call('POST', '/api/v1/topics/udv/authors', {
      name: 'Mestre Gabriel',
    });
    await call('PATCH', '/api/v1/topics/udv', { mainAuthor: 'mestre-gabriel' });

    for (const topic of ['udv', 'udv/palavra-do-mestre']) {
      const url = `/api/v1/topics/${encodeURIComponent(topic)}/research`;
      const asked = await call('POST', url, {
        question: 'O que o Mestre ensina sobre a burracheira?',
        profile: 'fast',
      });
      expect(asked?.statusCode).toBe(200);
      const system = llm.messagesSeen.at(-1)?.[0]?.content ?? '';
      expect(system).toMatch(
        /Atribua a Mestre Gabriel só o que está em documentos com autoria "Mestre Gabriel"/,
      );
      expect(system).not.toContain('Laércio');
    }

    const hermetismo = await call(
      'POST',
      '/api/v1/topics/hermetismo/research',
      {
        question: 'O que é o ritmo?',
        profile: 'fast',
      },
    );
    expect(hermetismo?.statusCode).toBe(200);
    expect(llm.messagesSeen.at(-1)?.[0]?.content).toContain(
      'Atribua a Mestre Laércio só',
    );
  });
});
