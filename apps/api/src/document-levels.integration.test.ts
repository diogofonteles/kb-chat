import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BulkLevelResult,
  LevelChoices,
  UnassignedPage,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeApp, type Call } from '../test/ai-app-harness.js';
import {
  createScale,
  doc,
  levelAudit,
  memberOf,
  placeDocuments,
  setPersonLevel,
  startLevels,
  writeDocs,
  type LevelsWorld,
  type VaultDoc,
} from '../test/levels-world.js';

const UNASSIGNED = '/api/v1/topics/hermetismo/levels/unassigned';
const BULK = '/api/v1/topics/hermetismo/document-levels';
const T0 = new Date('2026-11-01T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

afterEach(async () => {
  await closeApp();
  vi.useRealTimers();
});

/** Fixes the clock (only `Date`: timers and I/O run as usual). */
const at = (time: number | Date) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(time);
};

/** `count` new documents from kb, `audio` of them transcribed from an audio. */
const arrivals = (count: number, audio = 0): VaultDoc[] =>
  Array.from({ length: count }, (_, n) =>
    n < audio
      ? doc(`hermetismo/raw/novo-audio-${n}.md`, `Novo Audio ${n}`, {
          body: 'Uma fala nova.',
          extra: `source_path: audio/aula-${n}.mp3`,
        })
      : doc(`hermetismo/raw/novo-texto-${n}.md`, `Novo Texto ${n}`, 'Novo.'),
  );

/**
 * The reload a sync makes, and its reconcile: the queue answers only once every write queued
 * before it is done (R1-11), so asking for it waits for the reconcile, not for time.
 */
async function reload(world: LevelsWorld) {
  await world.started.catalog.load();
  const settled = await world.owner('GET', UNASSIGNED);
  expect(settled.statusCode, settled.body).toBe(200);
}

/** Documents the Mac adds, then the reload a sync makes. */
async function arrive(world: LevelsWorld, docs: readonly VaultDoc[]) {
  await writeDocs(world.vault, docs);
  await reload(world);
}

const page = async (call: Call, query = '') => {
  const answer = await call('GET', `${UNASSIGNED}${query}`);
  expect(answer.statusCode, answer.body).toBe(200);
  return answer.json<UnassignedPage>();
};

const documentUrl = (id: string, topic = 'hermetismo') =>
  `/api/v1/topics/${encodeURIComponent(topic)}/documents/${encodeURIComponent(id)}`;

/** The scale QS < CI < CDC over SIX (all at QS), and 40 new documents, 12 from audio. */
async function fortyNew() {
  at(T0);
  const world = await startLevels();
  await createScale(world, ['QS', 'CI', 'CDC']);
  await placeDocuments(world, { 'hermetismo:raw/cdc-1.md': 'cdc' });
  at(T0.getTime() + 1000);
  await arrive(world, arrivals(40, 12));
  const ana = await memberOf(world, 'ana@example.com');
  await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
  return { world, ana };
}

describe('Documents without a level and bulk levels (KBC-107, ADR 0036 §5)', () => {
  it('AC-1, BR-1, FR-1: the master sees "Sem nível (40)" a page at a time; Ana (CI, no content-levels) is refused', async () => {
    const { world, ana } = await fortyNew();
    const first = await page(world.owner);
    expect(first).toMatchObject({ collection: 'hermetismo', total: 40 });
    expect(first.matched).toBe(40);
    expect(first.items).toHaveLength(10);
    expect(first.items[0]).toMatchObject({
      topic: 'hermetismo',
      folder: 'raw',
      authorship: 'outros-autores',
      firstSeenAt: new Date(T0.getTime() + 1000).toISOString(),
    });
    expect(first.levels.map((one) => one.id)).toEqual(['qs', 'ci', 'cdc']);
    const seen = new Set(first.items.map((one) => one.id));
    let cursor = first.nextCursor;
    while (cursor) {
      const next = await page(
        world.owner,
        `?limit=50&cursor=${encodeURIComponent(cursor)}`,
      );
      for (const item of next.items) seen.add(item.id);
      cursor = next.nextCursor;
    }
    expect(seen.size).toBe(40);
    expect(
      (await world.owner('GET', `${UNASSIGNED}?limit=51`)).statusCode,
    ).toBe(400);
    const badCursor = await world.owner('GET', `${UNASSIGNED}?cursor=nope`);
    expect(badCursor.statusCode).toBe(400);
    const scale = await world.owner('GET', '/api/v1/topics/hermetismo/levels');
    expect(scale.json().unassigned).toBe(40);
    const counts = await world.owner('GET', '/api/v1/levels/unassigned');
    expect(counts.json()).toEqual({
      items: [{ collection: 'hermetismo', unassigned: 40 }],
    });

    expect((await ana.call('GET', UNASSIGNED)).statusCode).toBe(403);
    expect(
      (await ana.call('GET', '/api/v1/levels/unassigned')).statusCode,
    ).toBe(403);
    expect(
      (await ana.call('GET', documentUrl('raw/novo-texto-20.md'))).statusCode,
    ).toBe(404);
  });

  it('AC-2, AC-6, BR-3, BR-4: "origem: Áudio" selects 12, they go to CI, the queue says 28, Ana finds them, one bulk line and 12 item lines', async () => {
    const { world, ana } = await fortyNew();
    const audio = await page(world.owner, '?origin=audio');
    expect(audio.matched).toBe(12);
    expect(audio.facets.origins).toEqual(
      expect.arrayContaining([
        { value: 'audio', count: 12 },
        { value: 'text', count: 28 },
      ]),
    );
    expect(
      (await ana.call('GET', documentUrl('raw/novo-audio-3.md'))).statusCode,
    ).toBe(404);

    const given = await world.owner('POST', BULK, {
      level: 'ci',
      filter: { origin: 'audio', asOf: audio.asOf },
    });
    expect(given.statusCode, given.body).toBe(200);
    expect(given.json<BulkLevelResult>()).toEqual({
      level: { id: 'ci', code: 'CI' },
      updated: 12,
      skipped: 0,
    });
    expect((await page(world.owner)).total).toBe(28);
    expect((await page(world.owner, '?origin=audio')).matched).toBe(0);
    const found = await ana.call('GET', documentUrl('raw/novo-audio-3.md'));
    expect(found.statusCode).toBe(200);

    const audit = await levelAudit(world.started.state);
    const bulk = audit.filter(
      (one) => one.kind === 'bulk' && one.filter !== undefined,
    );
    expect(bulk).toHaveLength(1);
    expect(bulk[0]).toMatchObject({
      by: 'owner@example.com',
      collection: 'hermetismo',
      after: 'ci',
      count: { documents: 12, skipped: 0 },
      filter: { origin: 'audio', asOf: audio.asOf },
    });
    const items = audit.filter(
      (one) => one.kind === 'item.level' && one.after === 'ci',
    );
    expect(items).toHaveLength(12);
    expect(items[0]).toMatchObject({ collection: 'hermetismo', before: null });
  });

  it('AC-3, BR-3: three documents that arrive between the filter and the confirmation stay without a level', async () => {
    const { world } = await fortyNew();
    const listed = await page(world.owner, '?origin=audio');
    at(T0.getTime() + 60_000);
    await arrive(world, [
      doc('hermetismo/raw/tarde-1.md', 'Tarde 1', {
        body: 'Fala.',
        extra: 'source_path: audio/t1.mp3',
      }),
      doc('hermetismo/raw/tarde-2.md', 'Tarde 2', {
        body: 'Fala.',
        extra: 'source_path: audio/t2.mp3',
      }),
      doc('hermetismo/raw/tarde-3.md', 'Tarde 3', {
        body: 'Fala.',
        extra: 'source_path: audio/t3.mp3',
      }),
    ]);
    const given = await world.owner('POST', BULK, {
      level: 'qs',
      filter: { origin: 'audio', asOf: listed.asOf },
    });
    expect(given.json<BulkLevelResult>().updated).toBe(12);
    const left = await page(world.owner, '?origin=audio');
    expect(left.items.map((one) => one.id).sort()).toEqual([
      'raw/tarde-1.md',
      'raw/tarde-2.md',
      'raw/tarde-3.md',
    ]);
    const since = await page(world.owner, '?since=2026-11-01');
    expect(since.matched).toBe(31);
    expect((await page(world.owner, '?since=2026-11-02')).matched).toBe(0);
  });

  it('AC-4, AC-5, BR-2, FR-3: Caio (content-levels, CI) cannot give CDC, moves QS to CI, and hidden CDC ids come back as skipped', async () => {
    const { world } = await fortyNew();
    const caio = await memberOf(world, 'caio@example.com', {
      features: ['search', 'content-levels'],
    });
    await setPersonLevel(world, caio.id, { hermetismo: 'ci' });

    const choices = await caio.call(
      'GET',
      '/api/v1/topics/hermetismo/levels/choices',
    );
    expect(choices.json<LevelChoices>().levels.map((one) => one.id)).toEqual([
      'qs',
      'ci',
    ]);
    const queue = await page(caio.call);
    expect(queue.total).toBe(40);
    expect(queue.levels.map((one) => one.id)).toEqual(['qs', 'ci']);
    const above = await caio.call('POST', BULK, {
      level: 'cdc',
      ids: [{ topic: 'hermetismo', id: 'raw/novo-texto-20.md' }],
    });
    expect(above.statusCode).toBe(403);
    const one = await caio.call('PUT', `${documentUrl('raw/qs-1.md')}/level`, {
      level: 'cdc',
    });
    expect(one.statusCode).toBe(403);
    expect(
      (await caio.call('GET', '/api/v1/topics/hermetismo/levels')).statusCode,
    ).toBe(403);

    const moved = await caio.call('POST', BULK, {
      level: 'ci',
      ids: [
        { topic: 'hermetismo', id: 'raw/qs-1.md' },
        { topic: 'hermetismo', id: 'raw/qs-2.md' },
        { topic: 'hermetismo', id: 'raw/cdc-1.md' },
        { topic: 'hermetismo', id: 'raw/nao-existe.md' },
        { topic: 'alquimia', id: 'raw/qs-1.md' },
      ],
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json<BulkLevelResult>()).toMatchObject({
      updated: 2,
      skipped: 3,
    });
    const owner = await world.owner('GET', documentUrl('raw/qs-1.md'));
    expect(owner.json().level).toEqual({ id: 'ci', code: 'CI' });
    expect(
      (await world.owner('GET', documentUrl('raw/cdc-1.md'))).json().level,
    ).toEqual({ id: 'cdc', code: 'CDC' });
    expect(
      (await caio.call('GET', documentUrl('raw/cdc-1.md'))).statusCode,
    ).toBe(404);
    const unassigned = await caio.call(
      'GET',
      documentUrl('raw/novo-texto-20.md'),
    );
    expect(unassigned.statusCode).toBe(200);
    expect(unassigned.json().level).toBeNull();
  });

  it('FR-3: content-levels is granted per person and never comes with an invite by itself', async () => {
    at(T0);
    const world = await startLevels();
    const invited = await world.owner('POST', '/api/v1/people', {
      email: 'nova@example.com',
      sendEmail: false,
    });
    expect(invited.json().features).not.toContain('content-levels');
  });

  it('AC-7, BR-5, FR-5: a CI document removed on the Mac and back in 10 days keeps CI; after 31 days it comes back without a level', async () => {
    at(T0);
    const world = await startLevels();
    await createScale(world, ['QS', 'CI']);
    await placeDocuments(world, {
      'hermetismo:raw/ci-1.md': 'ci',
      'hermetismo:raw/cdc-1.md': 'ci',
    });
    const removed = ['ci-1.md', 'cdc-1.md'];
    for (const name of removed)
      await rm(join(world.vault, 'hermetismo', 'raw', name));
    await reload(world);
    expect((await page(world.owner)).total).toBe(0);

    at(T0.getTime() + 10 * DAY);
    await writeDocs(world.vault, [
      doc('hermetismo/raw/ci-1.md', 'Lua Media Uno', 'De volta.'),
    ]);
    await reload(world);
    expect(
      (await world.owner('GET', documentUrl('raw/ci-1.md'))).json().level,
    ).toEqual({ id: 'ci', code: 'CI' });

    at(T0.getTime() + 31 * DAY);
    await reload(world);
    await writeDocs(world.vault, [
      doc('hermetismo/raw/cdc-1.md', 'Zircônio Velado', 'De volta tarde.'),
    ]);
    await reload(world);
    expect(
      (await world.owner('GET', documentUrl('raw/cdc-1.md'))).json().level,
    ).toBeNull();
    const queue = await page(world.owner);
    expect(queue.items.map((one) => one.id)).toEqual(['raw/cdc-1.md']);
    expect(
      (await world.owner('GET', documentUrl('raw/ci-1.md'))).json().level,
    ).toEqual({ id: 'ci', code: 'CI' });
  });

  it('a collection without a scale has an empty queue; an unknown level is refused', async () => {
    at(T0);
    const world = await startLevels();
    expect((await page(world.owner)).total).toBe(0);
    await createScale(world, ['QS']);
    const unknown = await world.owner('POST', BULK, {
      level: 'nope',
      ids: [{ topic: 'hermetismo', id: 'raw/qs-1.md' }],
    });
    expect(unknown.statusCode).toBe(400);
    const empty = await world.owner('POST', BULK, { level: 'qs', ids: [] });
    expect(empty.statusCode).toBe(400);
  });
});
