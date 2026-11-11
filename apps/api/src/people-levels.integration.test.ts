import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LOCAL,
  OWNER_EMAIL,
  caller,
  closeApp,
  signIn,
  start,
} from '../test/ai-app-harness.js';
import { mintIdToken } from '../test/identity-factories.js';
import {
  createScale,
  levelAudit,
  memberOf,
  setPersonLevel,
  startLevels,
  type LevelsWorld,
} from '../test/levels-world.js';

afterEach(closeApp);

const PROFILES = '/api/v1/invite-profiles';
const BULK = '/api/v1/people/levels';

/** "Aluno": Hermetismo at CI (KBC-109 AC-1). */
const aluno = (levels: Record<string, string> = { hermetismo: 'ci' }) => ({
  name: 'Aluno',
  preset: { topics: ['hermetismo'], features: ['search'], levels },
});

async function createProfile(world: LevelsWorld, body: object) {
  const created = await world.owner('POST', PROFILES, body);
  expect(created.statusCode, created.body).toBe(201);
  return created.json<{ id: string }>().id;
}

const peopleFile = async (state: string) =>
  JSON.parse(await readFile(join(state, 'people.json'), 'utf8')).people as {
    email: string;
    id: string;
    levels?: Record<string, string>;
  }[];

describe('Levels in invitations, profiles, approvals and in bulk (KBC-109)', () => {
  it('AC-1, FR-1, FR-2: inviting with the "Aluno" profile puts the new person at CI, audited as an invitation', async () => {
    const world = await startLevels();
    await createScale(world, ['QS', 'CI', 'CDC']);
    const profileId = await createProfile(world, aluno());
    const listed = await world.owner('GET', PROFILES);
    expect(listed.json().items[0]).toMatchObject({
      preset: { levels: { hermetismo: 'ci' } },
      staleLevels: {},
    });

    const invited = await world.owner('POST', '/api/v1/people', {
      email: 'nova@example.com',
      sendEmail: false,
      profileId,
    });
    expect(invited.statusCode, invited.body).toBe(201);
    expect(invited.json().levels).toEqual({ hermetismo: 'ci' });
    const lines = (await levelAudit(world.started.state)).filter(
      (entry) => entry.kind === 'person.level',
    );
    expect(lines).toEqual([
      expect.objectContaining({
        by: OWNER_EMAIL,
        collection: 'hermetismo',
        target: invited.json().id,
        before: null,
        after: 'ci',
        via: 'invite',
      }),
    ]);
  });

  it('AC-2, BR-1, BR-5: a level for a collection left unmarked, without a scale or on a master preset is refused with 400', async () => {
    const world = await startLevels();
    await createScale(world, ['QS', 'CI']);
    const cases = [
      { topics: ['alquimia'], levels: { hermetismo: 'ci' } },
      { topics: ['hermetismo', 'alquimia'], levels: { alquimia: 'ci' } },
      { topics: ['hermetismo'], levels: { hermetismo: 'nope' } },
      { role: 'master', topics: [], levels: { hermetismo: 'ci' } },
    ];
    for (const preset of cases) {
      const refused = await world.owner('POST', PROFILES, {
        name: 'X',
        preset,
      });
      expect(refused.statusCode, JSON.stringify(preset)).toBe(400);
      expect(refused.json().error.code).toBe('VALIDATION_FAILED');
      const invited = await world.owner('POST', '/api/v1/people', {
        email: 'x@example.com',
        sendEmail: false,
        preset,
      });
      expect(invited.statusCode, JSON.stringify(preset)).toBe(400);
    }
    // Through a sub-collection the parent's scale is reached: its level is kept.
    const viaSub = await world.owner('POST', PROFILES, {
      name: 'Aulas',
      preset: { topics: ['hermetismo/aulas'], levels: { hermetismo: 'ci' } },
    });
    expect(viaSub.statusCode, viaSub.body).toBe(201);
    expect((await world.owner('GET', PROFILES)).json().items).toHaveLength(1);
  });

  it('AC-3, BR-2: applying a profile that brings only Hermetismo at CI keeps QS in Alquimia', async () => {
    const world = await startLevels();
    await createScale(world, ['QS', 'CI', 'CDC']);
    await createScale(world, ['QS', 'QM'], 'alquimia');
    const bia = await memberOf(world, 'bia@example.com', {
      topics: ['hermetismo', 'alquimia'],
    });
    await setPersonLevel(world, bia.id, { hermetismo: 'cdc', alquimia: 'qs' });
    const profileId = await createProfile(world, {
      name: 'Aluno',
      preset: {
        topics: ['hermetismo', 'alquimia'],
        levels: { hermetismo: 'ci' },
      },
    });
    const applied = await world.owner(
      'POST',
      `/api/v1/people/${bia.id}/profile`,
      { profileId },
    );
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json().levels).toEqual({ hermetismo: 'ci', alquimia: 'qs' });
    const last = (await levelAudit(world.started.state)).at(-1);
    expect(last).toMatchObject({
      kind: 'person.level',
      target: bia.id,
      before: 'cdc',
      after: 'ci',
      via: 'profile',
    });
  });

  it('AC-4, BR-3, FR-4: a profile whose level no longer exists is marked and invites at the lowest level', async () => {
    const world = await startLevels();
    await createScale(world, ['QS', 'CI']);
    const profileId = await createProfile(world, aluno());
    await closeApp();
    const scalesPath = join(world.started.state, 'access-levels.json');
    const scales = JSON.parse(await readFile(scalesPath, 'utf8'));
    scales.scales.hermetismo = scales.scales.hermetismo.filter(
      (one: { id: string }) => one.id !== 'ci',
    );
    await writeFile(scalesPath, JSON.stringify(scales));
    const again = await start({
      state: world.started.state,
      vault: world.vault,
    });
    const owner = caller(again.app, await signIn(again, OWNER_EMAIL));

    const listed = await owner('GET', PROFILES);
    expect(listed.json().items[0].staleLevels).toEqual({ hermetismo: 'ci' });
    const invited = await owner('POST', '/api/v1/people', {
      email: 'nova@example.com',
      sendEmail: false,
      profileId,
    });
    expect(invited.statusCode, invited.body).toBe(201);
    expect(invited.json().levels).toEqual({ hermetismo: 'qs' });
  });

  it('AC-5: an approved request given Hermetismo holds the lowest level, written and audited', async () => {
    const world = await startLevels();
    await createScale(world, ['QS', 'CI']);
    const credential = await mintIdToken(world.started.keys, {
      email: 'pede@example.com',
      sub: 'sub-pede',
    });
    const refused = await world.started.app.inject({
      method: 'POST',
      url: '/api/v1/auth/google',
      headers: LOCAL,
      payload: { credential },
    });
    const { ticket } = refused.json().error.details;
    const requested = await world.started.app.inject({
      method: 'POST',
      url: '/api/v1/access-requests/google',
      headers: LOCAL,
      payload: { ticket },
    });
    expect(requested.statusCode, requested.body).toBe(201);
    const [request] = (
      await world.owner('GET', '/api/v1/access-requests')
    ).json().items;
    const approved = await world.owner(
      'POST',
      `/api/v1/access-requests/${request.id}/approve`,
    );
    expect(approved.statusCode, approved.body).toBe(201);
    expect(approved.json().levels).toEqual({});

    const granted = await world.owner(
      'PATCH',
      `/api/v1/people/${approved.json().id}`,
      { topics: ['hermetismo'] },
    );
    expect(granted.statusCode, granted.body).toBe(200);
    expect(granted.json().levels).toEqual({ hermetismo: 'qs' });
    expect((await levelAudit(world.started.state)).at(-1)).toMatchObject({
      kind: 'person.level',
      target: approved.json().id,
      before: null,
      after: 'qs',
      via: 'editor',
    });
    // A second grant of the same collection changes and records nothing.
    const count = (await levelAudit(world.started.state)).length;
    await world.owner('PATCH', `/api/v1/people/${approved.json().id}`, {
      topics: ['hermetismo', 'alquimia'],
    });
    expect(await levelAudit(world.started.state)).toHaveLength(count);
  });

  it('AC-6, FR-3: three selected people go to CI with three audit lines; a master is skipped', async () => {
    const world = await startLevels();
    await createScale(world, ['QS', 'CI', 'CDC']);
    const ids: string[] = [];
    for (const email of ['a@example.com', 'b@example.com', 'c@example.com'])
      ids.push((await memberOf(world, email)).id);
    const outsider = await memberOf(world, 'fora@example.com', {
      topics: ['alquimia'],
    });
    const master = await memberOf(world, 'm@example.com');
    await world.owner('PATCH', `/api/v1/people/${master.id}`, {
      role: 'master',
    });
    const before = (await levelAudit(world.started.state)).length;

    const applied = await world.owner('POST', BULK, {
      ids: [...ids, master.id, outsider.id],
      topic: 'hermetismo',
      level: 'ci',
    });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json()).toEqual({
      collection: 'hermetismo',
      level: { id: 'ci', code: 'CI' },
      updated: 3,
      unchanged: 0,
      masters: 1,
      withoutAccess: 1,
      unknown: 0,
    });
    const people = await peopleFile(world.started.state);
    for (const id of ids)
      expect(people.find((one) => one.id === id)?.levels).toEqual({
        hermetismo: 'ci',
      });
    expect(
      people.find((one) => one.id === outsider.id)?.levels,
    ).toBeUndefined();
    const added = (await levelAudit(world.started.state)).slice(before);
    expect(added.filter((one) => one.kind === 'person.level')).toHaveLength(3);
    expect(added.find((one) => one.kind === 'bulk')).toMatchObject({
      collection: 'hermetismo',
      after: 'ci',
      count: { people: 3, skipped: 2 },
      filter: { ids: 5 },
      via: 'bulk',
    });
  });

  it('FR-3: the bulk is for masters, on a collection with that level', async () => {
    const world = await startLevels();
    await createScale(world, ['QS', 'CI']);
    const ana = await memberOf(world, 'ana@example.com');
    const body = { ids: [ana.id], topic: 'hermetismo', level: 'ci' };
    expect((await ana.call('POST', BULK, body)).statusCode).toBe(403);
    expect(
      (await world.owner('POST', BULK, { ...body, level: 'nope' })).statusCode,
    ).toBe(400);
    expect(
      (await world.owner('POST', BULK, { ...body, topic: 'alquimia' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await world.owner('POST', BULK, { ...body, ids: [] })).statusCode,
    ).toBe(400);
    const all = await world.owner('POST', BULK, {
      all: true,
      topic: 'hermetismo',
      level: 'ci',
    });
    expect(all.json()).toMatchObject({ updated: 1, masters: 1 });
  });

  it('NFR-1: a level for 500 people takes at most a second', async () => {
    const world = await startLevels();
    await createScale(world, ['QS', 'CI']);
    const state = world.started.state;
    const people = await peopleFile(state);
    const now = new Date().toISOString();
    const many = Array.from({ length: 500 }, (_, n) => ({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      sub: null,
      email: `p${n}@example.com`,
      name: '',
      picture: null,
      role: 'member',
      topics: ['hermetismo'],
      features: ['search'],
      invitedBy: OWNER_EMAIL,
      createdAt: now,
      lastLoginAt: null,
    }));
    await writeFile(
      join(state, 'people.json'),
      JSON.stringify({ version: 1, people: [...people, ...many] }),
    );
    await closeApp();
    const again = await start({ state, vault: world.vault });
    const owner = caller(again.app, await signIn(again, OWNER_EMAIL));
    const started = performance.now();
    const applied = await owner('POST', BULK, {
      ids: many.map((one) => one.id),
      topic: 'hermetismo',
      level: 'ci',
    });
    const elapsed = performance.now() - started;
    expect(applied.json().updated).toBe(500);
    expect(elapsed).toBeLessThanOrEqual(1000);
  });
});
