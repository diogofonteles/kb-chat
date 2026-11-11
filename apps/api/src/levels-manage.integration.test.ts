/**
 * Managing the scale after the fact (KBC-108, ADR 0036 §10, §11): deleting a level with
 * targets for its content and its people, the preview of a reorder, taking every level away
 * and "Histórico de níveis", through the app as main builds it.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  LevelAuditPage,
  LevelPreview,
  TopicLevels,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import { FsLevelAudit } from './adapters/fs-level-audit.js';
import { JsonDocumentStore } from './adapters/json-document-store.js';
import { JsonPeopleStore } from './adapters/json-people-store.js';
import { openMediaDatabase } from './adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from './adapters/sqlite/media-migrations.js';
import { SqliteMediaStore } from './adapters/sqlite/sqlite-media-store.js';
import {
  ContentGate,
  LevelDirectory,
  LevelWriteQueue,
  ScaleChangesService,
} from './modules/access-levels/index.js';
import type { ScaleChangesDeps } from './modules/access-levels/scale-changes-service.js';
import { scaleVersion } from './modules/access-levels/scale-version.js';
import { PeopleService, type StoredPerson } from './modules/auth/index.js';
import { CatalogRegistry } from './modules/catalog/index.js';
import type { DocumentStorePort } from './ports/document-store.js';
import type { LevelAuditPort } from './ports/level-audit.js';
import {
  SIX,
  createScale,
  doc,
  documentLevelUrl,
  levelAudit,
  memberOf,
  search,
  setPersonLevel,
  sixAtThreeLevels,
  startLevels,
  titlesOf,
  type LevelsWorld,
} from '../test/levels-world.js';

afterEach(closeApp);

const LEVELS = '/api/v1/topics/hermetismo/levels';
const AUDIT = '/api/v1/levels/audit';

/** Twelve "lua" texts for CI, one for QS and one for CDC (AC-1). */
const FOURTEEN = [
  doc('hermetismo/raw/qs-1.md', 'Lua Aberta', 'A lua no primeiro grau.'),
  doc('hermetismo/raw/cdc-1.md', 'Lua Velada', 'A lua no grau velado.'),
  ...Array.from({ length: 12 }, (_, n) =>
    doc(`hermetismo/raw/ci-${n}.md`, `Lua Media ${n}`, 'A lua no meio.'),
  ),
];

const mediaDb = (world: LevelsWorld) =>
  join(world.started.state, 'media', 'media.db');

/** Ready audios written straight to media.db, at the levels given. */
function seedAudios(world: LevelsWorld, levels: readonly string[]): string[] {
  const db = new DatabaseSync(mediaDb(world));
  const insert = db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
       upload_bytes, status, duration_ms, bytes, level, created_at, updated_at)
     VALUES (?, 'hermetismo', ?, 'outros-autores', 'seed', 'a.mp3', 1, 'ready', 1000, 1, ?, ?, ?)`,
  );
  const at = '2026-11-01T00:00:00.000Z';
  const ids = levels.map((level, n) => {
    const id = randomUUID();
    insert.run(id, `Palestra ${n}`, level, at, at);
    return id;
  });
  db.close();
  return ids;
}

function audioLevels(world: LevelsWorld): (string | null)[] {
  const db = new DatabaseSync(mediaDb(world));
  const rows = db
    .prepare('SELECT level FROM media ORDER BY title')
    .all()
    .map((row) => (row['level'] === null ? null : String(row['level'])));
  db.close();
  return rows;
}

const scaleOf = async (world: LevelsWorld) => {
  const read = await world.owner('GET', LEVELS);
  expect(read.statusCode, read.body).toBe(200);
  return read.json<TopicLevels>();
};

/** QS < CI < CDC; the twelve texts, three audios and four members at CI (AC-1). */
async function ciWorld() {
  const world = await startLevels(FOURTEEN, { media: true });
  await createScale(world, ['QS', 'CI', 'CDC']);
  const bulk = await world.owner(
    'POST',
    '/api/v1/topics/hermetismo/document-levels',
    {
      level: 'ci',
      ids: Array.from({ length: 12 }, (_, n) => ({
        topic: 'hermetismo',
        id: `raw/ci-${n}.md`,
      })),
    },
  );
  expect(bulk.statusCode, bulk.body).toBe(200);
  await world.owner('PUT', documentLevelUrl('hermetismo', 'raw/cdc-1.md'), {
    level: 'cdc',
  });
  seedAudios(world, ['ci', 'ci', 'ci', 'qs']);
  const members = [];
  for (const name of ['ana', 'bia', 'caio', 'davi']) {
    const member = await memberOf(world, `${name}@example.com`);
    await setPersonLevel(world, member.id, { hermetismo: 'ci' });
    members.push(member);
  }
  const eva = await memberOf(world, 'eva@example.com');
  return { world, members, eva };
}

describe('Deleting a level (KBC-108 FR-1, BR-1, BR-2)', () => {
  it('AC-1: with the default targets the 15 items go to CDC, the 4 people to QS, audited as one operation', async () => {
    const { world, members } = await ciWorld();
    const scale = await scaleOf(world);
    expect(scale.levels.map(({ id, media }) => [id, media])).toEqual([
      ['qs', 1],
      ['ci', 3],
      ['cdc', 0],
    ]);
    const preview = await world.owner('POST', `${LEVELS}/preview`, {
      remove: 'ci',
      version: scale.version,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const { removal, losing } = preview.json<LevelPreview>();
    expect(removal).toEqual({
      level: { id: 'ci', code: 'CI' },
      documents: 12,
      media: 3,
      people: 4,
      moveContentTo: 'cdc',
      movePeopleTo: 'qs',
      last: false,
    });
    expect(losing).toEqual({ people: 4, documents: 12, media: 3 });
    expect(preview.body).not.toContain('Lua Media');

    const deleted = await world.owner('DELETE', `${LEVELS}/ci`, {
      moveContentTo: 'cdc',
      movePeopleTo: 'qs',
      version: scale.version,
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    const after = deleted.json<TopicLevels>();
    expect(
      after.levels.map(({ id, documents, media, people }) => [
        id,
        documents,
        media,
        people,
      ]),
    ).toEqual([
      ['qs', 1, 1, 5],
      ['cdc', 13, 3, 0],
    ]);
    expect(after.version).not.toBe(scale.version);
    expect(audioLevels(world)).toEqual(['cdc', 'cdc', 'cdc', 'qs']);
    const [ana] = members;
    if (!ana) throw new Error('no member');
    expect(titlesOf((await search(ana.call, 'lua')).json())).toEqual([
      'Lua Aberta',
    ]);
    const audit = await levelAudit(world.started.state);
    const head = audit.find((one) => one.kind === 'scale.delete');
    expect(head).toMatchObject({
      by: 'owner@example.com',
      collection: 'hermetismo',
      target: 'ci',
      after: { moveContentTo: 'cdc', movePeopleTo: 'qs' },
      count: { documents: 12, media: 3, people: 4 },
    });
    const at = head?.at;
    const lines = audit.filter((one) => one.at === at);
    expect(lines.filter((one) => one.kind === 'item.level')).toHaveLength(15);
    expect(lines.filter((one) => one.kind === 'person.level')).toHaveLength(4);
  });

  it('AC-2: without moveContentTo it answers 400 and nothing changes', async () => {
    const { world } = await ciWorld();
    const scale = await scaleOf(world);
    const lines = (await levelAudit(world.started.state)).length;
    const refused = await world.owner('DELETE', `${LEVELS}/ci`, {
      movePeopleTo: 'qs',
      version: scale.version,
    });
    expect(refused.statusCode).toBe(400);
    const same = await world.owner('DELETE', `${LEVELS}/ci`, {
      moveContentTo: 'ci',
      movePeopleTo: 'qs',
      version: scale.version,
    });
    expect(same.statusCode).toBe(400);
    expect(await scaleOf(world)).toEqual(scale);
    expect(audioLevels(world)).toEqual(['ci', 'ci', 'ci', 'qs']);
    expect(await levelAudit(world.started.state)).toHaveLength(lines);
  });

  it('BR-2 edges: deleting the highest sends content down, deleting the lowest sends people up', async () => {
    const world = await startLevels();
    await sixAtThreeLevels(world);
    const { version } = await scaleOf(world);
    const top = await world.owner('POST', `${LEVELS}/preview`, {
      remove: 'cdc',
      version,
    });
    expect(top.json<LevelPreview>().removal).toMatchObject({
      moveContentTo: 'ci',
      movePeopleTo: 'ci',
    });
    const bottom = await world.owner('POST', `${LEVELS}/preview`, {
      remove: 'qs',
      version,
    });
    expect(bottom.json<LevelPreview>().removal).toMatchObject({
      moveContentTo: 'ci',
      movePeopleTo: 'ci',
    });
  });

  it('AC-6: the only level is not deleted alone: it asks for every level to go', async () => {
    const world = await startLevels();
    await createScale(world, ['QS']);
    const { version } = await scaleOf(world);
    const preview = await world.owner('POST', `${LEVELS}/preview`, {
      remove: 'qs',
      version,
    });
    expect(preview.json<LevelPreview>().removal).toMatchObject({
      last: true,
      moveContentTo: null,
      movePeopleTo: null,
    });
    const refused = await world.owner('DELETE', `${LEVELS}/qs`, {
      moveContentTo: 'qs',
      movePeopleTo: 'qs',
      version,
    });
    expect(refused.statusCode).toBe(400);
    expect((await scaleOf(world)).levels).toHaveLength(1);
  });

  it('refuses a member (403 for the feature) and a sub-collection (400)', async () => {
    const world = await startLevels();
    await sixAtThreeLevels(world);
    const { version } = await scaleOf(world);
    const ana = await memberOf(world, 'ana@example.com');
    const body = { moveContentTo: 'cdc', movePeopleTo: 'qs', version };
    expect((await ana.call('DELETE', `${LEVELS}/ci`, body)).statusCode).toBe(
      403,
    );
    expect(
      (
        await world.owner(
          'DELETE',
          '/api/v1/topics/hermetismo%2Faulas/levels/ci',
          body,
        )
      ).statusCode,
    ).toBe(400);
  });
});

describe('Moving with the preview of its impact (KBC-108 FR-2, BR-3)', () => {
  it('AC-3: the preview counts who gains and loses; a scale changed since then answers 409', async () => {
    const world = await startLevels();
    await sixAtThreeLevels(world);
    const ana = await memberOf(world, 'ana@example.com');
    const bia = await memberOf(world, 'bia@example.com');
    await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
    await setPersonLevel(world, bia.id, { hermetismo: 'cdc' });
    const { version } = await scaleOf(world);
    const preview = await world.owner('POST', `${LEVELS}/preview`, {
      order: ['qs', 'cdc', 'ci'],
      version,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json<LevelPreview>()).toMatchObject({
      version,
      gaining: { people: 1, documents: 2, media: 0 },
      losing: { people: 1, documents: 2, media: 0 },
      removal: null,
    });
    const renamed = await world.owner('PATCH', `${LEVELS}/qs`, {
      description: 'Quadro Social',
    });
    expect(renamed.statusCode).toBe(200);
    const stale = await world.owner('PATCH', LEVELS, {
      order: ['qs', 'cdc', 'ci'],
      version,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('LEVELS_CHANGED');
    const stalePreview = await world.owner('POST', `${LEVELS}/preview`, {
      order: ['qs', 'cdc', 'ci'],
      version,
    });
    expect(stalePreview.statusCode).toBe(409);
    const fresh = (await scaleOf(world)).version;
    const moved = await world.owner('PATCH', LEVELS, {
      order: ['qs', 'cdc', 'ci'],
      version: fresh,
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(titlesOf((await search(ana.call, 'lua')).json())).toHaveLength(6);
  });
});

describe('Taking every level away (KBC-108 FR-3, BR-4)', () => {
  it('AC-4: a wrong name is refused; the right one leaves no scale and Ana sees everything', async () => {
    const world = await startLevels(SIX, { media: true });
    await sixAtThreeLevels(world);
    seedAudios(world, ['cdc', 'qs']);
    const ana = await memberOf(world, 'ana@example.com');
    await setPersonLevel(world, ana.id, { hermetismo: 'qs' });
    expect(titlesOf((await search(ana.call, 'lua')).json())).toHaveLength(2);
    const { version } = await scaleOf(world);
    const wrong = await world.owner('DELETE', LEVELS, {
      confirm: 'alquimia',
      version,
    });
    expect(wrong.statusCode).toBe(400);
    const cleared = await world.owner('DELETE', LEVELS, {
      confirm: 'hermetismo',
      version,
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json<TopicLevels>()).toMatchObject({
      levels: [],
      unassigned: 0,
    });
    expect(titlesOf((await search(ana.call, 'lua')).json())).toHaveLength(6);
    expect(audioLevels(world)).toEqual([null, null]);
    const person = (await world.owner('GET', '/api/v1/people'))
      .json()
      .items.find((one: { id: string }) => one.id === ana.id);
    expect(person.levels ?? {}).toEqual({});
    const audit = await levelAudit(world.started.state);
    expect(audit.find((one) => one.kind === 'scale.clear')).toMatchObject({
      before: ['qs', 'ci', 'cdc'],
      count: { documents: 6, media: 2, people: 1 },
    });
  });
});

describe('"Histórico de níveis" (KBC-108 FR-4, BR-5)', () => {
  it('AC-5: three changes of one item, one acting as another, newest first; a member gets 403', async () => {
    const world = await startLevels();
    await sixAtThreeLevels(world);
    const ana = await memberOf(world, 'ana@example.com', {
      features: ['search', 'content-levels'],
    });
    await setPersonLevel(world, ana.id, { hermetismo: 'cdc' });
    const item = documentLevelUrl('hermetismo', 'raw/qs-1.md');
    await world.owner('PUT', item, { level: 'ci' });
    const acting = await world.owner(
      'POST',
      `/api/v1/people/${ana.id}/act-as`,
      {
        reason: 'conferir a classificação',
      },
    );
    expect(acting.statusCode, acting.body).toBe(200);
    expect((await world.owner('PUT', item, { level: 'cdc' })).statusCode).toBe(
      200,
    );
    await world.owner('DELETE', '/api/v1/act-as');
    await world.owner('PUT', item, { level: 'qs' });

    const read = await world.owner(
      'GET',
      `${AUDIT}?topic=hermetismo&target=${encodeURIComponent('raw/qs-1.md')}`,
    );
    expect(read.statusCode, read.body).toBe(200);
    const page = read.json<LevelAuditPage>();
    expect(
      page.items.map(({ before, after, actingAs, targetLabel, subject }) => ({
        before,
        after,
        actingAs,
        targetLabel,
        subject,
      })),
    ).toEqual([
      {
        before: 'CDC',
        after: 'QS',
        actingAs: null,
        targetLabel: 'Lua Primeira Aberta',
        subject: 'document',
      },
      {
        before: 'CI',
        after: 'CDC',
        actingAs: 'ana@example.com',
        targetLabel: 'Lua Primeira Aberta',
        subject: 'document',
      },
      {
        before: 'QS',
        after: 'CI',
        actingAs: null,
        targetLabel: 'Lua Primeira Aberta',
        subject: 'document',
      },
    ]);
    expect(page.nextCursor).toBeNull();
    expect((await ana.call('GET', AUDIT)).statusCode).toBe(403);
  });

  it('pages newest first with a cursor and filters by kind and day', async () => {
    const world = await startLevels();
    await sixAtThreeLevels(world);
    for (let n = 0; n < 15; n += 1)
      await world.owner('PATCH', `${LEVELS}/qs`, { description: `Q${n}` });
    const twenty = await world.owner('GET', `${AUDIT}?topic=hermetismo`);
    const page20 = twenty.json<LevelAuditPage>();
    const after20 = await world.owner(
      'GET',
      `${AUDIT}?topic=hermetismo&cursor=${page20.nextCursor}`,
    );
    expect([
      ...page20.items,
      ...after20.json<LevelAuditPage>().items,
    ]).toHaveLength((await levelAudit(world.started.state)).length);
    const first = await world.owner('GET', `${AUDIT}?topic=hermetismo&limit=2`);
    const one = first.json<LevelAuditPage>();
    expect(one.items).toHaveLength(2);
    expect(one.nextCursor).not.toBeNull();
    const second = await world.owner(
      'GET',
      `${AUDIT}?topic=hermetismo&limit=50&cursor=${one.nextCursor}`,
    );
    const rest = second.json<LevelAuditPage>();
    const all = [...one.items, ...rest.items];
    expect(all).toHaveLength((await levelAudit(world.started.state)).length);
    expect(all.map((line) => line.at)).toEqual(
      [...all.map((line) => line.at)].sort().reverse(),
    );
    expect(rest.nextCursor).toBeNull();
    const creates = await world.owner(
      'GET',
      `${AUDIT}?kind=scale.create&topic=hermetismo`,
    );
    expect(
      creates.json<LevelAuditPage>().items.map((line) => line.after),
    ).toEqual(['CDC', 'CI', 'QS']);
    const none = await world.owner('GET', `${AUDIT}?to=2020-01-01`);
    expect(none.json<LevelAuditPage>().items).toEqual([]);
    const bad = await world.owner('GET', `${AUDIT}?cursor=nope`);
    expect(bad.statusCode).toBe(400);
  });
});

/* ---------- NFR-2, AC-7: all or nothing over every store, with a failure injected ---------- */

const MASTER_EMAIL = 'owner@example.com';
const ITEMS = { documents: 4000, media: 1000 };

const member = (n: number, level?: string): StoredPerson => ({
  id: `0f0e0d0c-0b0a-4908-8706-${String(n).padStart(12, '0')}`,
  sub: null,
  email: `p${n}@example.com`,
  name: `P${n}`,
  picture: null,
  role: 'member',
  topics: ['hermetismo'],
  features: ['search'],
  invitedBy: MASTER_EMAIL,
  createdAt: '2026-11-01T00:00:00.000Z',
  lastLoginAt: null,
  ...(level && { levels: { hermetismo: level } }),
});

type Step = 'media' | 'documents' | 'people' | 'scale' | 'audit';

/** A file store whose next write fails once `failing` names it (a full disk). */
function failingStore(
  inner: DocumentStorePort,
  name: Step,
  armed: { failing: Step | null },
): DocumentStorePort {
  return {
    read: () => inner.read(),
    write: async (value) => {
      if (armed.failing === name) {
        armed.failing = null;
        throw new Error(`disk full (${name})`);
      }
      await inner.write(value);
    },
  };
}

async function atomicWorld() {
  const dir = await mkdtemp(join(tmpdir(), 'kbchat-levels-atomic-'));
  const armed: { failing: Step | null } = { failing: null };
  const ids = Array.from(
    { length: ITEMS.documents },
    (_, n) => `raw/d-${n}.md`,
  );
  const catalog = new CatalogRegistry({
    listTopics: async () => [{ slug: 'hermetismo', title: 'Hermetismo' }],
    listDocuments: async () => ids,
    readDocument: async (_topic, id) => `---\ntitle: Doc ${id}\n---\n`,
  });
  await catalog.load();
  const json = (file: string, step: Step) =>
    failingStore(new JsonDocumentStore(join(dir, file)), step, armed);
  const directory = new LevelDirectory({
    scales: json('access-levels.json', 'scale'),
    documents: json('document-levels.json', 'documents'),
    presence: json('document-presence.json', 'documents'),
  });
  await directory.load();
  const people = new PeopleService({
    store: failingStore(
      new JsonPeopleStore(join(dir, 'people.json')),
      'people',
      armed,
    ),
    ownerEmail: MASTER_EMAIL,
  });
  const db = openMediaDatabase(join(dir, 'media.db'), MEDIA_MIGRATIONS);
  const store = new SqliteMediaStore(db);
  const media: ScaleChangesDeps['media'] = {
    countLevels: (topics) => store.countLevels(topics),
    restoreLevels: (rows) => store.restoreLevels(rows),
    relevel: (change) => {
      if (armed.failing === 'media') throw new Error('disk full (media)');
      return store.relevel(change);
    },
  };
  const fsAudit = new FsLevelAudit(join(dir, 'audit'));
  const audit: LevelAuditPort = {
    append: (entry) => fsAudit.append(entry),
    read: (query) => fsAudit.read(query),
    appendMany: (entries) =>
      armed.failing === 'audit'
        ? Promise.reject(new Error('disk full (audit)'))
        : fsAudit.appendMany(entries),
  };
  const gate = new ContentGate({ directory, catalog });
  const log = { error: vi.fn() };
  const changes = new ScaleChangesService({
    queue: new LevelWriteQueue(),
    directory,
    catalog,
    gate,
    parentOf: () => null,
    people,
    media,
    audit,
  });
  return { dir, armed, db, directory, people, changes, log, ids };
}

async function seedAtomic(world: Awaited<ReturnType<typeof atomicWorld>>) {
  const at = '2026-11-01T00:00:00.000Z';
  const level = (id: string, code: string) => ({
    id,
    code,
    description: '',
    createdBy: MASTER_EMAIL,
    createdAt: at,
  });
  await world.directory.changeScale('hermetismo', () => ({
    next: [level('qs', 'QS'), level('ci', 'CI'), level('cdc', 'CDC')],
    result: undefined,
  }));
  const placed = { level: 'ci', setBy: MASTER_EMAIL, setAt: at };
  await world.directory.place({
    hermetismo: Object.fromEntries(world.ids.map((id) => [id, placed])),
  });
  await writeFile(
    join(world.dir, 'people.json'),
    JSON.stringify({
      version: 1,
      people: [
        { ...member(0), email: MASTER_EMAIL, role: 'master', topics: [] },
        member(1, 'ci'),
        member(2, 'ci'),
        member(3),
        member(4, 'cdc'),
      ],
    }),
  );
  const insert = world.db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
       upload_bytes, status, duration_ms, bytes, level, created_at, updated_at)
     VALUES (?, 'hermetismo', 'Palestra', 'outros-autores', 'seed', 'a.mp3', 1, 'ready', 1, 1, ?, ?, ?)`,
  );
  world.db.exec('BEGIN');
  for (let n = 0; n < ITEMS.media; n++)
    insert.run(`m-${String(n).padStart(4, '0')}`, n % 2 ? 'ci' : 'qs', at, at);
  world.db.exec('COMMIT');
}

/** Every store as it is on disk: the three files, people.json, media.db's levels, the audit. */
async function onDisk(world: Awaited<ReturnType<typeof atomicWorld>>) {
  const file = async (name: string) =>
    JSON.parse(await readFile(join(world.dir, name), 'utf8')) as unknown;
  const audit = await readdir(join(world.dir, 'audit')).catch(() => []);
  return {
    scales: await file('access-levels.json'),
    documents: await file('document-levels.json'),
    people: await file('people.json'),
    media: world.db
      .prepare('SELECT id, level FROM media ORDER BY id')
      .all()
      .map((row) => `${String(row['id'])}:${String(row['level'])}`),
    audit,
  };
}

describe('Deleting a level is all or nothing (KBC-108 NFR-2, AC-7)', () => {
  it.each<Step>(['media', 'documents', 'people', 'scale', 'audit'])(
    'a failure writing %s leaves the files and media.db as they were',
    async (step) => {
      const world = await atomicWorld();
      await seedAtomic(world);
      const before = await onDisk(world);
      const scaleBefore = world.directory.scaleOf('hermetismo');
      world.armed.failing = step;

      await expect(
        world.changes.remove(
          { actor: { by: MASTER_EMAIL }, log: world.log },
          { topic: 'hermetismo', level: 'ci' },
          {
            moveContentTo: 'cdc',
            movePeopleTo: 'qs',
            version: scaleVersion(scaleBefore),
          },
        ),
      ).rejects.toThrow(`disk full (${step})`);

      expect(await onDisk(world)).toEqual(before);
      expect(world.directory.scaleOf('hermetismo')).toEqual(scaleBefore);
      expect(
        world.directory.placementsOf('hermetismo')['raw/d-0.md']?.level,
      ).toBe('ci');
      expect(world.log.error).not.toHaveBeenCalled();
      world.db.close();
    },
  );

  it('without a failure, the 5,000 items and the people move in one go', async () => {
    const world = await atomicWorld();
    await seedAtomic(world);
    await world.changes.remove(
      { actor: { by: MASTER_EMAIL }, log: world.log },
      { topic: 'hermetismo', level: 'ci' },
      {
        moveContentTo: 'cdc',
        movePeopleTo: 'qs',
        version: scaleVersion(world.directory.scaleOf('hermetismo')),
      },
    );
    const placed = Object.values(world.directory.placementsOf('hermetismo'));
    expect(placed.every((one) => one.level === 'cdc')).toBe(true);
    expect(placed).toHaveLength(ITEMS.documents);
    const people = await world.people.list();
    expect(people.map((one) => one.levels?.['hermetismo'] ?? null)).toEqual([
      null,
      'qs',
      'qs',
      null,
      'cdc',
    ]);
    const levels = world.db
      .prepare(
        'SELECT level, COUNT(*) AS n FROM media GROUP BY level ORDER BY level',
      )
      .all()
      .map((row) => [row['level'], Number(row['n'])]);
    expect(levels).toEqual([
      ['cdc', 500],
      ['qs', 500],
    ]);
    world.db.close();
  });
});
