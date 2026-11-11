import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOCAL,
  OWNER_EMAIL,
  caller,
  closeApp,
  connectHouse,
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

  it('ADR 0036 §11: a level written but not audited is logged with what changed, and the request fails', async () => {
    const world = await startLevels();
    await createScale(world, ['QS', 'CI']);
    const profileId = await createProfile(world, aluno());
    const dir = join(world.started.state, 'audit');
    const [file] = (await readdir(dir)).filter((one) =>
      one.startsWith('levels-'),
    );
    const path = join(dir, file ?? '');
    await chmod(path, 0o400);
    try {
      const invited = await world.owner('POST', '/api/v1/people', {
        email: 'nova@example.com',
        sendEmail: false,
        profileId,
      });
      expect(invited.statusCode).toBe(500);
    } finally {
      await chmod(path, 0o600);
    }
    expect(
      world.started.logs.some((line) =>
        line.includes('person levels changed but not audited'),
      ),
    ).toBe(true);
    const people = await peopleFile(world.started.state);
    expect(
      people.find((one) => one.email === 'nova@example.com')?.levels,
    ).toEqual({ hermetismo: 'ci' });
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

  it('R1-4: a level is never written on a master, nor on someone made master in the same change', async () => {
    const world = await startLevels();
    await createScale(world, ['QS', 'CI']);
    const ana = await memberOf(world, 'ana@example.com');
    const promoted = await world.owner('PATCH', `/api/v1/people/${ana.id}`, {
      role: 'master',
      levels: { hermetismo: 'ci' },
    });
    expect(promoted.statusCode).toBe(400);
    expect(promoted.json().error.code).toBe('VALIDATION_FAILED');
    await world.owner('PATCH', `/api/v1/people/${ana.id}`, { role: 'master' });
    const onMaster = await world.owner('PATCH', `/api/v1/people/${ana.id}`, {
      levels: { hermetismo: 'ci' },
    });
    expect(onMaster.statusCode).toBe(400);
    // Becoming master dropped the level she held (R2-2), and the refusal wrote none.
    const people = await peopleFile(world.started.state);
    expect(people.find((one) => one.id === ana.id)?.levels).toBeUndefined();
  });

  it('R1-5: a master made member gets the lowest level of the collections with a scale, audited', async () => {
    const world = await startLevels();
    const bia = await memberOf(world, 'bia@example.com');
    await world.owner('PATCH', `/api/v1/people/${bia.id}`, { role: 'master' });
    await createScale(world, ['QS', 'CI']);
    const demoted = await world.owner('PATCH', `/api/v1/people/${bia.id}`, {
      role: 'member',
    });
    expect(demoted.statusCode, demoted.body).toBe(200);
    expect(demoted.json().levels).toEqual({ hermetismo: 'qs' });
    expect((await levelAudit(world.started.state)).at(-1)).toMatchObject({
      kind: 'person.level',
      target: bia.id,
      before: null,
      after: 'qs',
      via: 'editor',
    });
  });

  it('R1-2: a profile renamed without its preset keeps a person at CI when applied', async () => {
    const world = await startLevels();
    const profileId = await createProfile(world, {
      name: 'Antigo',
      preset: { topics: ['hermetismo'] },
    });
    await createScale(world, ['QS', 'CI']);
    const ana = await memberOf(world, 'ana@example.com');
    await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
    const renamed = await world.owner('PUT', `${PROFILES}/${profileId}`, {
      name: 'Antigo renomeado',
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().preset.levels).toBeUndefined();
    const applied = await world.owner(
      'POST',
      `/api/v1/people/${ana.id}/profile`,
      { profileId },
    );
    expect(applied.json().levels).toEqual({ hermetismo: 'ci' });
  });

  it('QA-2, R1-6: the editor and the bulk racing on one person leave an unbroken audit chain', async () => {
    const world = await startLevels();
    await createScale(world, ['QS', 'CI', 'CDC']);
    const ana = await memberOf(world, 'ana@example.com');
    const from = (await levelAudit(world.started.state)).length;
    for (let n = 0; n < 15; n += 1) {
      const [patch, bulk] = await Promise.all([
        world.owner('PATCH', `/api/v1/people/${ana.id}`, {
          levels: { hermetismo: n % 2 === 0 ? 'cdc' : 'qs' },
        }),
        world.owner('POST', BULK, {
          ids: [ana.id],
          topic: 'hermetismo',
          level: n % 2 === 0 ? 'ci' : 'cdc',
        }),
      ]);
      expect(patch.statusCode, patch.body).toBe(200);
      expect(bulk.statusCode, bulk.body).toBe(200);
    }
    const lines = (await levelAudit(world.started.state))
      .slice(from)
      .filter((one) => one.kind === 'person.level' && one.target === ana.id);
    for (let i = 1; i < lines.length; i += 1)
      expect(lines[i]?.before, `line ${i}`).toBe(lines[i - 1]?.after);
    const final = (await peopleFile(world.started.state)).find(
      (one) => one.id === ana.id,
    )?.levels?.['hermetismo'];
    expect(final).toBe(lines.at(-1)?.after);
  });

  it('R1-6: a grant racing the first level of a scale is placed and audited once', async () => {
    const world = await startLevels();
    const invited = await world.owner('POST', '/api/v1/people', {
      email: 'corrida@example.com',
      sendEmail: false,
    });
    const id = invited.json().id as string;
    const [granted, created] = await Promise.all([
      world.owner('PATCH', `/api/v1/people/${id}`, { topics: ['hermetismo'] }),
      world.owner('POST', '/api/v1/topics/hermetismo/levels', { code: 'QS' }),
    ]);
    expect(granted.statusCode).toBe(200);
    expect(created.statusCode).toBe(201);
    const people = await peopleFile(world.started.state);
    expect(people.find((one) => one.id === id)?.levels).toEqual({
      hermetismo: 'qs',
    });
    // Whichever goes first, she is recorded once: by the grant's own line, or counted in
    // the first scale's seed (ADR 0036 §4) when the grant came before the scale.
    const audit = await levelAudit(world.started.state);
    const own = audit.filter(
      (one) => one.kind === 'person.level' && one.target === id,
    );
    const seeded =
      audit.find(
        (one) => one.kind === 'bulk' && one.count?.people !== undefined,
      )?.count?.people ?? 0;
    expect(own.length + seeded).toBe(1);
    if (own.length === 1)
      expect(own[0]).toMatchObject({ before: null, after: 'qs' });
  });

  it('R2-2: member at CI, made master, made member again ends at the lowest, each change audited', async () => {
    const world = await startLevels();
    await createScale(world, ['QS', 'CI']);
    const ana = await memberOf(world, 'ana@example.com');
    await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
    const from = (await levelAudit(world.started.state)).length;
    const promoted = await world.owner('PATCH', `/api/v1/people/${ana.id}`, {
      role: 'master',
    });
    expect(promoted.json().levels).toEqual({});
    const demoted = await world.owner('PATCH', `/api/v1/people/${ana.id}`, {
      role: 'member',
    });
    expect(demoted.json().levels).toEqual({ hermetismo: 'qs' });
    const lines = (await levelAudit(world.started.state))
      .slice(from)
      .filter((one) => one.kind === 'person.level' && one.target === ana.id)
      .map(({ before, after, via }) => [before, after, via]);
    expect(lines).toEqual([
      ['ci', null, 'editor'],
      [null, 'qs', 'editor'],
    ]);
  });

  it('R2-2: a master profile applied to a member drops her levels, audited', async () => {
    const world = await startLevels();
    await createScale(world, ['QS', 'CI']);
    const ana = await memberOf(world, 'ana@example.com');
    await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
    const profileId = await createProfile(world, {
      name: 'Master',
      preset: { role: 'master' },
    });
    const applied = await world.owner(
      'POST',
      `/api/v1/people/${ana.id}/profile`,
      { profileId },
    );
    expect(applied.json().levels).toEqual({});
    expect((await levelAudit(world.started.state)).at(-1)).toMatchObject({
      target: ana.id,
      before: 'ci',
      after: null,
      via: 'profile',
    });
  });
});

describe('Undoing what the house AI cannot follow (KBC-109 R2-1, QA-r2-2)', () => {
  async function paidWorld() {
    const world = await startLevels();
    await createScale(world, ['QS', 'CI', 'CDC']);
    await connectHouse(world.started, world.owner);
    await world.owner('PUT', '/api/v1/house-ai', {
      paidModel: 'fake/paid',
      managementKey: 'sk-or-v1-mgmt-0001',
    });
    const profileId = await createProfile(world, {
      name: 'Pago',
      preset: {
        topics: ['hermetismo'],
        levels: { hermetismo: 'cdc' },
        ai: {
          appAi: 'house',
          paidFallback: { enabled: true, monthlyCapUsd: 2 },
        },
      },
    });
    return { world, profileId };
  }

  it('R2-1: a bulk slipping in while the profile waits for the AI keeps its level, the chain unbroken', async () => {
    const { world, profileId } = await paidWorld();
    const ana = await memberOf(world, 'ana@example.com');
    await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
    const from = (await levelAudit(world.started.state)).length;
    world.started.fake.failManagement = true;
    world.started.fake.beforeManagement = async () => {
      const bulk = await world.owner('POST', BULK, {
        ids: [ana.id],
        topic: 'hermetismo',
        level: 'qs',
      });
      expect(bulk.statusCode, bulk.body).toBe(200);
    };

    const applied = await world.owner(
      'POST',
      `/api/v1/people/${ana.id}/profile`,
      { profileId },
    );

    expect(applied.statusCode).toBe(503);
    const people = await peopleFile(world.started.state);
    expect(people.find((one) => one.id === ana.id)?.levels).toEqual({
      hermetismo: 'qs',
    });
    const lines = (await levelAudit(world.started.state))
      .slice(from)
      .filter((one) => one.kind === 'person.level' && one.target === ana.id);
    expect(lines.map(({ before, after, via }) => [before, after, via])).toEqual(
      [
        ['ci', 'cdc', 'profile'],
        ['cdc', 'qs', 'bulk'],
      ],
    );
  });

  it('R2-1: without anyone in between, the undo brings the level back and audits it', async () => {
    const { world, profileId } = await paidWorld();
    const ana = await memberOf(world, 'ana@example.com');
    await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
    const from = (await levelAudit(world.started.state)).length;
    world.started.fake.failManagement = true;
    const applied = await world.owner(
      'POST',
      `/api/v1/people/${ana.id}/profile`,
      { profileId },
    );
    expect(applied.statusCode).toBe(503);
    const lines = (await levelAudit(world.started.state))
      .slice(from)
      .filter((one) => one.target === ana.id)
      .map(({ before, after }) => [before, after]);
    expect(lines).toEqual([
      ['ci', 'cdc'],
      ['cdc', 'ci'],
    ]);
  });

  it('R2-1: an undo whose audit fails is logged as done but not audited, not as not undone', async () => {
    const { world, profileId } = await paidWorld();
    const ana = await memberOf(world, 'ana@example.com');
    await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
    const dir = join(world.started.state, 'audit');
    const [file] = (await readdir(dir)).filter((one) =>
      one.startsWith('levels-'),
    );
    const path = join(dir, file ?? '');
    world.started.fake.failManagement = true;
    world.started.fake.beforeManagement = () => chmod(path, 0o400);
    try {
      const applied = await world.owner(
        'POST',
        `/api/v1/people/${ana.id}/profile`,
        { profileId },
      );
      expect(applied.statusCode).toBe(503);
    } finally {
      await chmod(path, 0o600);
    }
    const logs = world.started.logs.join('\n');
    expect(logs).toContain('profile undone but its levels not audited');
    expect(logs).not.toContain('could not undo a profile');
    const people = await peopleFile(world.started.state);
    expect(people.find((one) => one.id === ana.id)?.levels).toEqual({
      hermetismo: 'ci',
    });
  });

  it('QA-r2-2: an invitation undone because the AI failed audits its level going back', async () => {
    const { world, profileId } = await paidWorld();
    world.started.fake.failManagement = true;
    const invited = await world.owner('POST', '/api/v1/people', {
      email: 'nova@example.com',
      sendEmail: false,
      profileId,
    });
    expect(invited.statusCode).toBe(503);
    const lines = (await levelAudit(world.started.state))
      .filter((one) => one.kind === 'person.level' && one.via === 'invite')
      .map(({ before, after }) => [before, after]);
    expect(lines).toEqual([
      [null, 'cdc'],
      ['cdc', null],
    ]);
    const people = await peopleFile(world.started.state);
    expect(people.some((one) => one.email === 'nova@example.com')).toBe(false);
  });

  it('R3-2: an invitation undone after a bulk moved the person audits from the level she has now', async () => {
    const { world, profileId } = await paidWorld();
    world.started.fake.failManagement = true;
    world.started.fake.beforeManagement = async () => {
      const bulk = await world.owner('POST', BULK, {
        all: true,
        topic: 'hermetismo',
        level: 'qs',
      });
      expect(bulk.statusCode, bulk.body).toBe(200);
    };
    const invited = await world.owner('POST', '/api/v1/people', {
      email: 'nova@example.com',
      sendEmail: false,
      profileId,
    });
    expect(invited.statusCode).toBe(503);
    const lines = (await levelAudit(world.started.state))
      .filter(
        (one) =>
          one.kind === 'person.level' &&
          (one.via === 'invite' || one.via === 'bulk'),
      )
      .map(({ before, after, via }) => [before, after, via]);
    expect(lines).toEqual([
      [null, 'cdc', 'invite'],
      ['cdc', 'qs', 'bulk'],
      ['qs', null, 'invite'],
    ]);
  });

  it('R3-3: when re-reading the person fails during the undo, the client still gets the AI failure and the log says the profile stays', async () => {
    const { world, profileId } = await paidWorld();
    const ana = await memberOf(world, 'ana@example.com');
    const path = join(world.started.state, 'people.json');
    const kept = await readFile(path, 'utf8');
    world.started.fake.failManagement = true;
    // The cached people are a minute old and the file cannot be read: the undo's read fails.
    world.started.fake.beforeManagement = async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
      await writeFile(path, '{ not json');
    };
    try {
      const applied = await world.owner(
        'POST',
        `/api/v1/people/${ana.id}/profile`,
        { profileId },
      );
      expect(applied.statusCode).toBe(503);
    } finally {
      vi.useRealTimers();
      await writeFile(path, kept);
    }
    expect(world.started.logs.join('\n')).toContain(
      'could not undo a profile; it stays applied',
    );
  });
});
