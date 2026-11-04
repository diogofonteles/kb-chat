import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollectionSpeaker } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OWNER_EMAIL,
  caller,
  closeApp,
  signIn,
  start,
} from '../test/ai-app-harness.js';
import { FIXTURE_VAULT } from '../test/fixture-paths.js';
import { member, startMedia } from '../test/media-harness.js';

afterEach(closeApp);

const URL = '/api/v1/topics/hermetismo/speakers';

/** A copy of the fixture vault with `udv` and its sub-collection. */
async function vaultWithUdv(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kbchat-speakers-'));
  await cp(FIXTURE_VAULT, root, { recursive: true });
  const sub = join(root, 'udv', 'palavra-do-mestre');
  await mkdir(sub, { recursive: true });
  await writeFile(join(root, 'udv', 'topic.yaml'), 'title: UDV\n');
  await writeFile(join(sub, 'topic.yaml'), 'title: Palavra do Mestre\n');
  return root;
}

describe('The speakers of a collection (KBC-065 FR-1, AC-7, BR-2)', () => {
  it('registers, lists by name and keeps one speaker for one name', async () => {
    const { owner } = await startMedia();
    const created = await owner('POST', URL, { name: '  Maria   da Paz ' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: 'Maria da Paz',
      authorSlug: null,
      main: false,
    });
    const again = await owner('POST', URL, { name: 'MARIA DA PÁZ' });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(created.json().id);
    await owner('POST', URL, { name: 'Ana' });
    const list = await owner('GET', URL);
    expect(
      list.json<{ items: CollectionSpeaker[] }>().items.map((one) => one.name),
    ).toEqual(['Ana', 'Maria da Paz']);
  });

  it("AC-2, BR-1: a sub-collection lists and keeps its parent's speakers", async () => {
    const started = await start({ media: true, vault: await vaultWithUdv() });
    const owner = caller(started.app, await signIn(started, OWNER_EMAIL));
    const sub = `/api/v1/topics/${encodeURIComponent('udv/palavra-do-mestre')}/speakers`;
    const created = await owner('POST', sub, { name: 'Mestre Gabriel' });
    expect(created.statusCode, created.body).toBe(201);
    const parent = await owner('GET', '/api/v1/topics/udv/speakers');
    expect(parent.json().items).toEqual([created.json()]);
    expect((await owner('GET', sub)).json()).toEqual(parent.json());
  });

  it.each([
    ['empty', ''],
    ['121 characters', 'a'.repeat(121)],
    ['two lines', 'Ana\nMaria'],
    ['with guillemets', 'Ana «Maria»'],
  ])('AC-7: refuses a name that is %s and creates nothing', async (_, name) => {
    const { owner } = await startMedia();
    expect((await owner('POST', URL, { name })).statusCode).toBe(400);
    expect((await owner('GET', URL)).json().items).toEqual([]);
  });

  it('takes a name of 120 characters', async () => {
    const { owner } = await startMedia();
    const name = 'a'.repeat(120);
    expect((await owner('POST', URL, { name })).statusCode).toBe(201);
  });

  it('BR-2: a speaker linked to an author shows the author, once', async () => {
    const { owner } = await startMedia();
    const linked = await owner('POST', URL, {
      name: 'O Mestre',
      authorSlug: 'mestre-laercio',
    });
    expect(linked.statusCode).toBe(201);
    expect(linked.json()).toMatchObject({
      name: 'Mestre Laércio',
      authorSlug: 'mestre-laercio',
      main: true,
    });
    const again = await owner('POST', URL, {
      name: 'Outro nome',
      authorSlug: 'mestre-laercio',
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(linked.json().id);
    const unknown = await owner('POST', URL, {
      name: 'Alguém',
      authorSlug: 'ninguem',
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('renames, links, and refuses a name another speaker has or an unknown id', async () => {
    const { owner } = await startMedia();
    const ana = (await owner('POST', URL, { name: 'Ana' })).json();
    await owner('POST', URL, { name: 'Bia' });
    const renamed = await owner('PATCH', `${URL}/${ana.id}`, {
      name: 'Ana Maria',
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id: ana.id, name: 'Ana Maria' });
    const taken = await owner('PATCH', `${URL}/${ana.id}`, { name: 'BIA' });
    expect(taken.statusCode).toBe(409);
    const linked = await owner('PATCH', `${URL}/${ana.id}`, {
      name: 'Ana Maria',
      authorSlug: 'mestre-laercio',
    });
    expect(linked.json().main).toBe(true);
    const unlinked = await owner('PATCH', `${URL}/${ana.id}`, {
      name: 'Ana Maria',
      authorSlug: null,
    });
    expect(unlinked.json()).toMatchObject({
      name: 'Ana Maria',
      authorSlug: null,
    });
    const missing = await owner(
      'PATCH',
      `${URL}/00000000-0000-4000-8000-000000000000`,
      { name: 'Zé' },
    );
    expect(missing.statusCode).toBe(404);
  });

  it('AC-7: refuses a name made only of combining marks (400, not a failure)', async () => {
    const { owner } = await startMedia();
    const marks = { name: '\u0301\u0302' };
    expect((await owner('POST', URL, marks)).statusCode).toBe(400);
    const ana = (await owner('POST', URL, { name: 'Ana' })).json<{
      id: string;
    }>();
    expect((await owner('PATCH', `${URL}/${ana.id}`, marks)).statusCode).toBe(
      400,
    );
  });

  it('BR-4: reading or changing the list also needs `media`; with both it works', async () => {
    const media = await startMedia();
    const created = await media.owner('POST', URL, { name: 'Ana' });
    const { id } = created.json<{ id: string }>();
    const noAudio = await member(media, {
      email: 'edita@example.com',
      topics: ['hermetismo'],
      features: ['media-edit'],
    });
    expect((await noAudio.call('GET', URL)).statusCode).toBe(403);
    expect((await noAudio.call('POST', URL, { name: 'Bia' })).statusCode).toBe(
      403,
    );
    expect(
      (await noAudio.call('PATCH', `${URL}/${id}`, { name: 'Bia' })).statusCode,
    ).toBe(403);

    const both = await member(media, {
      email: 'ambos@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-edit'],
    });
    expect((await both.call('GET', URL)).statusCode).toBe(200);
    expect((await both.call('POST', URL, { name: 'Bia' })).statusCode).toBe(
      201,
    );
    expect(
      (await both.call('PATCH', `${URL}/${id}`, { name: 'Cida' })).statusCode,
    ).toBe(200);
  });

  it('BR-4: needs `media-edit` on the collection, and a collection that exists', async () => {
    const media = await startMedia();
    const { call } = await member(media, {
      email: 'ouve@example.com',
      topics: ['hermetismo'],
      features: ['media'],
    });
    expect((await call('GET', URL)).statusCode).toBe(403);
    expect((await call('POST', URL, { name: 'Ana' })).statusCode).toBe(403);
    const other = await member(media, {
      email: 'fora@example.com',
      topics: [],
      features: ['media', 'media-edit'],
    });
    expect((await other.call('GET', URL)).statusCode).toBe(404);
    const missing = await media.owner(
      'GET',
      '/api/v1/topics/nao-existe/speakers',
    );
    expect(missing.statusCode).toBe(404);
  });
});
