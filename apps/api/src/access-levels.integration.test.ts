import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TopicLevels } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OWNER_EMAIL,
  caller,
  closeApp,
  signIn,
  start,
} from '../test/ai-app-harness.js';
import {
  createScale,
  documentLevelUrl,
  levelAudit,
  memberOf,
  placeDocuments,
  search,
  setPersonLevel,
  startLevels,
  titlesOf,
  reorderScale,
} from '../test/levels-world.js';

afterEach(closeApp);

const LEVELS = '/api/v1/topics/hermetismo/levels';

describe('Access levels per collection: the scale (KBC-103, ADR 0036)', () => {
  it('AC-1, FR-2, BR-4: the first level places every document and member at it, audited as one bulk', async () => {
    const world = await startLevels();
    const ana = await memberOf(world, 'ana@example.com');
    await memberOf(world, 'bia@example.com', {
      topics: ['hermetismo/aulas'],
    });
    await memberOf(world, 'caio@example.com', { topics: ['alquimia'] });
    const before = titlesOf((await search(ana.call, 'lua')).json());
    expect(before).toHaveLength(6);

    const empty = await world.owner('GET', LEVELS);
    expect(empty.json()).toMatchObject({
      collection: 'hermetismo',
      inherited: false,
      levels: [],
      documents: 6,
      people: 2,
      unassigned: 0,
    });
    const created = await world.owner('POST', LEVELS, {
      code: 'QS',
      description: 'Quadro Social',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<TopicLevels>().levels).toEqual([
      {
        id: 'qs',
        code: 'QS',
        description: 'Quadro Social',
        documents: 6,
        people: 2,
        media: 0,
      },
    ]);
    const stored = JSON.parse(
      await readFile(join(world.started.state, 'document-levels.json'), 'utf8'),
    );
    expect(Object.keys(stored.collections).sort()).toEqual([
      'hermetismo',
      'hermetismo/aulas',
    ]);
    const people = JSON.parse(
      await readFile(join(world.started.state, 'people.json'), 'utf8'),
    ).people;
    const levelsOf = (email: string) =>
      people.find((one: { email: string }) => one.email === email)?.levels;
    expect(levelsOf('ana@example.com')).toEqual({ hermetismo: 'qs' });
    expect(levelsOf('bia@example.com')).toEqual({ hermetismo: 'qs' });
    expect(levelsOf('caio@example.com')).toBeUndefined();
    const bulk = (await levelAudit(world.started.state)).filter(
      (entry) => entry.kind === 'bulk',
    );
    expect(bulk).toHaveLength(1);
    expect(bulk[0]).toMatchObject({
      by: 'owner@example.com',
      collection: 'hermetismo',
      after: 'qs',
      count: { documents: 6, people: 2 },
    });
    expect(titlesOf((await search(ana.call, 'lua')).json())).toEqual(before);
  });

  it('AC-11, BR-2: a code taken ignoring case and accents is refused; renaming keeps the id and the items', async () => {
    const world = await startLevels();
    await createScale(world, ['QS', 'CI']);
    await placeDocuments(world, { 'hermetismo:raw/ci-1.md': 'ci' });
    const taken = await world.owner('POST', LEVELS, { code: 'ci' });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toMatchObject({
      code: 'LEVEL_CODE_TAKEN',
      details: { code: 'CI' },
    });
    const accents = await world.owner('POST', LEVELS, { code: 'Qś' });
    expect(accents.statusCode).toBe(409);
    const tooLong = await world.owner('POST', LEVELS, { code: 'A'.repeat(13) });
    expect(tooLong.statusCode).toBe(400);

    const renamed = await world.owner('PATCH', `${LEVELS}/ci`, {
      code: 'C.I.',
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json<TopicLevels>().levels[1]).toMatchObject({
      id: 'ci',
      code: 'C.I.',
      documents: 1,
    });
    const docLevel = await world.owner(
      'GET',
      '/api/v1/topics/hermetismo/documents/raw%2Fci-1.md',
    );
    expect(docLevel.json().level).toEqual({ id: 'ci', code: 'C.I.' });
    const clash = await world.owner('PATCH', `${LEVELS}/ci`, { code: 'qs' });
    expect(clash.statusCode).toBe(409);
    const unknown = await world.owner('PATCH', `${LEVELS}/nope`, {
      code: 'X',
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('AC-12, BR-3: moving CDC below CI opens it to CI at once, with the order audited before and after', async () => {
    const world = await startLevels();
    const ana = await memberOf(world, 'ana@example.com');
    await createScale(world, ['QS', 'CI', 'CDC']);
    await placeDocuments(world, { 'hermetismo:raw/cdc-1.md': 'cdc' });
    await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
    expect(titlesOf((await search(ana.call, 'lua')).json())).not.toContain(
      'Zircônio Velado',
    );
    const wrong = await reorderScale(world, ['qs', 'ci']);
    expect(wrong.statusCode).toBe(400);
    const moved = await reorderScale(world, ['qs', 'cdc', 'ci']);
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json<TopicLevels>().levels.map((one) => one.id)).toEqual([
      'qs',
      'cdc',
      'ci',
    ]);
    expect(titlesOf((await search(ana.call, 'lua')).json())).toContain(
      'Zircônio Velado',
    );
    const reorder = (await levelAudit(world.started.state)).find(
      (entry) => entry.kind === 'scale.reorder',
    );
    expect(reorder).toMatchObject({
      before: ['qs', 'ci', 'cdc'],
      after: ['qs', 'cdc', 'ci'],
    });
  });

  it('AC-13, BR-9: a member gets 403 on every level write and 404 in a collection they do not see', async () => {
    const world = await startLevels();
    const ana = await memberOf(world, 'ana@example.com');
    await createScale(world, ['QS']);
    expect((await ana.call('GET', LEVELS)).statusCode).toBe(403);
    expect((await ana.call('POST', LEVELS, { code: 'X' })).statusCode).toBe(
      403,
    );
    expect(
      (await ana.call('PATCH', LEVELS, { order: ['qs'] })).statusCode,
    ).toBe(403);
    expect(
      (
        await ana.call('PUT', documentLevelUrl('hermetismo', 'raw/qs-1.md'), {
          level: 'qs',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await ana.call('PATCH', `/api/v1/people/${ana.id}`, {
          levels: { hermetismo: 'qs' },
        })
      ).statusCode,
    ).toBe(403);
    const unseen = await ana.call('POST', '/api/v1/topics/alquimia/levels', {
      code: 'X',
    });
    expect(unseen.statusCode).toBe(404);
  });

  it('BR-1, FR-3: a sub-collection uses its parent scale; a person level must name a level of a scale', async () => {
    const world = await startLevels();
    const ana = await memberOf(world, 'ana@example.com');
    await createScale(world, ['QS', 'CI']);
    const sub = await world.owner(
      'GET',
      `/api/v1/topics/${encodeURIComponent('hermetismo/aulas')}/levels`,
    );
    expect(sub.json()).toMatchObject({
      collection: 'hermetismo',
      inherited: true,
    });
    expect(sub.json().levels.map((one: { id: string }) => one.id)).toEqual([
      'qs',
      'ci',
    ]);
    const ownScale = await world.owner(
      'POST',
      `/api/v1/topics/${encodeURIComponent('hermetismo/aulas')}/levels`,
      { code: 'X' },
    );
    expect(ownScale.statusCode).toBe(400);
    for (const levels of [
      { hermetismo: 'cdc' },
      { alquimia: 'qs' },
      { 'hermetismo/aulas': 'qs' },
    ]) {
      const refused = await world.owner('PATCH', `/api/v1/people/${ana.id}`, {
        levels,
      });
      expect(refused.statusCode, JSON.stringify(levels)).toBe(400);
    }
    const scales = await world.owner('GET', '/api/v1/levels');
    expect(scales.json()).toEqual({
      items: [
        {
          collection: 'hermetismo',
          levels: [
            { id: 'qs', code: 'QS' },
            { id: 'ci', code: 'CI' },
          ],
        },
      ],
    });
    expect((await ana.call('GET', '/api/v1/levels')).statusCode).toBe(403);
    const set = await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
    expect(set.json().levels).toEqual({ hermetismo: 'ci' });
    const audit = (await levelAudit(world.started.state)).find(
      (entry) => entry.kind === 'person.level',
    );
    expect(audit).toMatchObject({
      target: ana.id,
      collection: 'hermetismo',
      before: 'qs',
      after: 'ci',
    });
    const badLevel = await world.owner(
      'PUT',
      documentLevelUrl('hermetismo', 'raw/qs-1.md'),
      { level: 'nope' },
    );
    expect(badLevel.statusCode).toBe(400);
    const noDoc = await world.owner(
      'PUT',
      documentLevelUrl('hermetismo', 'raw/none.md'),
      { level: 'qs' },
    );
    expect(noDoc.statusCode).toBe(404);
  });

  it('QA-3, BR-2: a code of symbols gets a short id, and the state still loads after a restart', async () => {
    const world = await startLevels();
    for (const code of ['++++++++++++', 'A+B+C+D+E+F+']) {
      const created = await world.owner('POST', LEVELS, { code });
      expect(created.statusCode, created.body).toBe(201);
    }
    const ids = (await world.owner('GET', LEVELS))
      .json<TopicLevels>()
      .levels.map((one) => one.id);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(40);
    await closeApp();
    const again = await start({
      state: world.started.state,
      vault: world.vault,
    });
    const owner = caller(again.app, await signIn(again, OWNER_EMAIL));
    const reloaded = await owner('GET', LEVELS);
    expect(reloaded.statusCode).toBe(200);
    expect(reloaded.json<TopicLevels>().levels.map((one) => one.id)).toEqual(
      ids,
    );
  });

  it('a master asking for the levels of a collection that does not exist gets 404', async () => {
    const world = await startLevels();
    const missing = await world.owner('GET', '/api/v1/topics/nada/levels');
    expect(missing.statusCode).toBe(404);
  });
});
