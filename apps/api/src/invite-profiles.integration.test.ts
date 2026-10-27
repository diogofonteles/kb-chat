import { afterEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  caller,
  closeApp,
  connectHouse,
  signIn,
  start,
  withPeople,
  type Started,
} from '../test/ai-app-harness.js';

afterEach(closeApp);

const ALUNO = {
  name: 'Aluno',
  preset: {
    topics: ['hermetismo'],
    features: ['search', 'research'],
    ai: { appAi: 'house', dailyResearches: 3 },
    preferences: {
      defaultTopic: 'hermetismo',
      defaultView: 'research',
      researchProfile: 'fast',
      theme: 'dark',
    },
  },
};

const PESQUISADOR = {
  name: 'Pesquisador',
  preset: {
    topics: ['hermetismo'],
    features: ['search', 'research', 'own-ai-settings'],
    ai: { appAi: 'house', dailyResearches: 10, enforced: true },
    preferences: { researchProfile: 'deep', theme: 'light' },
  },
};

async function owner(started: Started) {
  return caller(started.app, await signIn(started, 'owner@example.com'));
}

describe('Invite profiles (KBC-028)', () => {
  it('invites with a profile: access, AI with its history, and the first Settings (AC-1)', async () => {
    const started = await start();
    const master = await owner(started);
    const created = await master('POST', '/api/v1/invite-profiles', ALUNO);
    expect(created.statusCode).toBe(201);
    const invited = await master('POST', '/api/v1/people', {
      email: 'aluno@example.com',
      profileId: created.json().id,
    });
    expect(invited.statusCode).toBe(201);
    expect(invited.json()).toMatchObject({
      role: 'member',
      topics: ['hermetismo'],
      features: ['search', 'research'],
      ai: { appAi: 'house', dailyResearches: 3 },
      initialPreferences: { defaultView: 'research', theme: 'dark' },
    });
    expect(invited.json().ai.history.at(-1)).toMatchObject({
      appAi: 'house',
      by: 'owner@example.com',
    });
    const aluno = caller(
      started.app,
      await signIn(started, 'aluno@example.com'),
    );
    const settings = (await aluno('GET', '/api/v1/settings')).json();
    expect(settings.exists).toBe(false);
    expect(settings.preferences).toMatchObject({
      defaultTopic: 'hermetismo',
      defaultView: 'research',
      researchProfile: 'fast',
      theme: 'dark',
    });
    // A first save of something else keeps them (they become the person's own).
    const put = await aluno('PUT', '/api/v1/settings', {
      preferences: { searchMode: 'all' },
    });
    expect(put.statusCode).toBe(200);
    const saved = (await aluno('GET', '/api/v1/settings')).json();
    expect(saved.exists).toBe(true);
    expect(saved.preferences.theme).toBe('dark');
  });

  it('invites with a preset of its own, and uses the default profile when none is chosen (AC-2, AC-3)', async () => {
    const started = await start();
    const master = await owner(started);
    const aluno = (
      await master('POST', '/api/v1/invite-profiles', {
        ...ALUNO,
        isDefault: true,
      })
    ).json();
    const pesquisador = (
      await master('POST', '/api/v1/invite-profiles', PESQUISADOR)
    ).json();
    // A preset adjusted at the invitation leaves the profile as it was.
    const adjusted = await master('POST', '/api/v1/people', {
      email: 'ajustado@example.com',
      preset: {
        ...ALUNO.preset,
        ai: { appAi: 'house', dailyResearches: 7 },
      },
    });
    expect(adjusted.json().ai.dailyResearches).toBe(7);
    const profiles = (await master('GET', '/api/v1/invite-profiles')).json();
    expect(
      profiles.items.find((p: { id: string }) => p.id === aluno.id).preset.ai
        .dailyResearches,
    ).toBe(3);
    // Only one default (BR-3).
    await master('PUT', `/api/v1/invite-profiles/${pesquisador.id}`, {
      isDefault: true,
    });
    const after = (await master('GET', '/api/v1/invite-profiles')).json();
    expect(
      after.items.filter((p: { isDefault: boolean }) => p.isDefault),
    ).toEqual([expect.objectContaining({ id: pesquisador.id })]);
    const plain = await master('POST', '/api/v1/people', {
      email: 'padrao@example.com',
    });
    expect(plain.json()).toMatchObject({
      features: ['search', 'research', 'own-ai-settings'],
      ai: { enforced: true, dailyResearches: 10 },
    });
    // Deleting the default leaves no default: a plain invitation is today's.
    await master('DELETE', `/api/v1/invite-profiles/${pesquisador.id}`);
    const bare = await master('POST', '/api/v1/people', {
      email: 'simples@example.com',
    });
    expect(bare.json()).toMatchObject({ topics: [], features: ['search'] });
    expect(bare.json()).not.toHaveProperty('initialPreferences');
  });

  it('applies a profile to someone already there, never over their saved preferences (AC-4)', async () => {
    const started = await start();
    const { owner: master, member, memberId } = await withPeople(started);
    await member('PUT', '/api/v1/settings', {
      preferences: { theme: 'light' },
    });
    const profile = (
      await master('POST', '/api/v1/invite-profiles', ALUNO)
    ).json();
    const applied = await master('POST', `/api/v1/people/${memberId}/profile`, {
      profileId: profile.id,
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({
      features: ['search', 'research'],
      ai: { appAi: 'house', dailyResearches: 3 },
    });
    expect(applied.json().ai.history.at(-1).by).toBe('owner@example.com');
    const settings = (await member('GET', '/api/v1/settings')).json();
    expect(settings.preferences.theme).toBe('light');
    // The role changes too.
    const coordinator = (
      await master('POST', '/api/v1/invite-profiles', {
        name: 'Coordenação',
        preset: { role: 'master' },
      })
    ).json();
    const promoted = await master(
      'POST',
      `/api/v1/people/${memberId}/profile`,
      { profileId: coordinator.id },
    );
    expect(promoted.json().role).toBe('master');
  });

  it('refuses a lent subscription, a default collection not granted, and anyone but a master (AC-5)', async () => {
    const started = await start();
    const { owner: master, member } = await withPeople(started);
    expect(
      (
        await master('POST', '/api/v1/invite-profiles', {
          name: 'X',
          preset: { ai: { appAi: 'claude-subscription' } },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await master('POST', '/api/v1/people', {
          email: 'x@example.com',
          preset: { preferences: { defaultTopic: 'hermetismo' } },
        })
      ).statusCode,
    ).toBe(400);
    expect((await member('GET', '/api/v1/invite-profiles')).statusCode).toBe(
      403,
    );
    expect(
      (await member('POST', '/api/v1/invite-profiles', ALUNO)).statusCode,
    ).toBe(403);
  });

  it('lends a subscription in the invitation only from the owner, with the terms, recorded (KBC-031 AC-5, AC-6)', async () => {
    const started = await start();
    const { owner: master, memberId } = await withPeople(started);
    const lending = (terms: boolean) => ({
      topics: ['hermetismo'],
      features: ['search', 'research'],
      ai: {
        appAi: 'claude-subscription',
        ...(terms && { subscriptionTermsAccepted: true }),
      },
    });
    const withoutTerms = await master('POST', '/api/v1/people', {
      email: 'sem-termos@example.com',
      preset: lending(false),
    });
    expect(withoutTerms.statusCode).toBe(400);
    const lent = await master('POST', '/api/v1/people', {
      email: 'cedida@example.com',
      preset: lending(true),
    });
    expect(lent.statusCode).toBe(201);
    expect(lent.json().ai.appAi).toBe('claude-subscription');
    expect(lent.json().ai.history.at(-1)).toMatchObject({
      appAi: 'claude-subscription',
      by: 'owner@example.com',
      termsAccepted: true,
    });
    // Another master may invite, but never lends the owner's subscription (BR-1).
    await master('PATCH', `/api/v1/people/${memberId}`, { role: 'master' });
    const other = caller(started.app, await signIn(started, 'ana@example.com'));
    const refused = await other('POST', '/api/v1/people', {
      email: 'outra@example.com',
      preset: lending(true),
    });
    expect(refused.statusCode).toBe(403);
    expect(
      (await master('GET', '/api/v1/people'))
        .json()
        .items.some(
          (person: { email: string }) => person.email === 'outra@example.com',
        ),
    ).toBe(false);
    // A reusable profile still never holds one (BR-3).
    expect(
      (
        await master('POST', '/api/v1/invite-profiles', {
          name: 'Cedido',
          preset: lending(true),
        })
      ).statusCode,
    ).toBe(400);
  });

  it('answers 404 for an unknown profile or person, 401/403 to anyone but a master', async () => {
    const started = await start();
    const { owner: master, member, memberId } = await withPeople(started);
    const unknown = '00000000-0000-4000-8000-000000000000';
    const profile = (
      await master('POST', '/api/v1/invite-profiles', ALUNO)
    ).json();
    const statuses = [
      await master('POST', '/api/v1/people', {
        email: 'y@example.com',
        profileId: unknown,
      }),
      await master('POST', `/api/v1/people/${memberId}/profile`, {
        profileId: unknown,
      }),
      await master('POST', `/api/v1/people/${unknown}/profile`, {
        profileId: profile.id,
      }),
      await master('PUT', `/api/v1/invite-profiles/${unknown}`, { name: 'Z' }),
      await master('DELETE', `/api/v1/invite-profiles/${unknown}`),
    ].map((response) => response.statusCode);
    expect(statuses).toEqual([404, 404, 404, 404, 404]);
    expect(
      (
        await member('POST', `/api/v1/people/${memberId}/profile`, {
          profileId: profile.id,
        })
      ).statusCode,
    ).toBe(403);
    const anonymous = await started.app.inject({
      method: 'GET',
      url: '/api/v1/invite-profiles',
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('refuses a collection that does not exist, in a profile or a preset', async () => {
    const started = await start();
    const master = await owner(started);
    const ghost = { name: 'G', preset: { topics: ['nao-existe'] } };
    expect(
      (await master('POST', '/api/v1/invite-profiles', ghost)).statusCode,
    ).toBe(400);
    const created = (
      await master('POST', '/api/v1/invite-profiles', ALUNO)
    ).json();
    expect(
      (
        await master('PUT', `/api/v1/invite-profiles/${created.id}`, {
          preset: ghost.preset,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await master('POST', '/api/v1/people', {
          email: 'z@example.com',
          preset: ghost.preset,
        })
      ).statusCode,
    ).toBe(400);
  });

  it('undoes an invitation or a profile the house cannot follow (OpenRouter down)', async () => {
    const started = await start();
    const { owner: master, memberId } = await withPeople(started);
    await connectHouse(started, master);
    await master('PUT', '/api/v1/house-ai', {
      paidModel: 'fake/paid',
      managementKey: 'sk-or-v1-mgmt-0001',
    });
    const paid = {
      name: 'Pago',
      preset: {
        topics: ['hermetismo'],
        ai: {
          appAi: 'house',
          paidFallback: { enabled: true, monthlyCapUsd: 2 },
        },
      },
    };
    const profile = (
      await master('POST', '/api/v1/invite-profiles', paid)
    ).json();
    started.fake.failManagement = true;

    const refused = await master('POST', '/api/v1/people', {
      email: 'pago@example.com',
      profileId: profile.id,
    });
    expect(refused.statusCode).toBe(503);
    const emails = (await master('GET', '/api/v1/people'))
      .json()
      .items.map((p: { email: string }) => p.email);
    expect(emails).not.toContain('pago@example.com');

    const before = (await master('GET', '/api/v1/people'))
      .json()
      .items.find((p: { id: string }) => p.id === memberId);
    const applied = await master('POST', `/api/v1/people/${memberId}/profile`, {
      profileId: profile.id,
    });
    expect(applied.statusCode).toBe(503);
    const after = (await master('GET', '/api/v1/people'))
      .json()
      .items.find((p: { id: string }) => p.id === memberId);
    expect(after).toEqual(before);

    started.fake.failManagement = false;
    const again = await master('POST', '/api/v1/people', {
      email: 'pago@example.com',
      profileId: profile.id,
    });
    expect(again.statusCode).toBe(201);
  });

  it('never overwrites an unreadable invite-profiles.json', async () => {
    const first = await start();
    const file = join(first.state, 'invite-profiles.json');
    await closeApp();
    await writeFile(file, '{"version": 1, "profiles": [{"oops": true}]}');
    const started = await start({ state: first.state });
    const master = await owner(started);
    expect(started.logs.join('\n')).toContain(
      'invite-profiles.json is invalid',
    );
    expect(
      (await master('POST', '/api/v1/invite-profiles', ALUNO)).statusCode,
    ).toBe(500);
    expect(await readFile(file, 'utf8')).toContain('oops');
  });

  it('a later profile replaces the earlier initial preferences, none included', async () => {
    const started = await start();
    const master = await owner(started);
    const aluno = (
      await master('POST', '/api/v1/invite-profiles', ALUNO)
    ).json();
    const plain = (
      await master('POST', '/api/v1/invite-profiles', {
        name: 'Simples',
        preset: {},
      })
    ).json();
    const invited = (
      await master('POST', '/api/v1/people', {
        email: 'troca@example.com',
        profileId: aluno.id,
      })
    ).json();
    await master('POST', `/api/v1/people/${invited.id}/profile`, {
      profileId: plain.id,
    });
    const person = caller(
      started.app,
      await signIn(started, 'troca@example.com'),
    );
    const settings = (await person('GET', '/api/v1/settings')).json();
    expect(settings.preferences.theme).toBe('auto');
  });

  it('drops an initial default collection the person no longer sees', async () => {
    const started = await start();
    const master = await owner(started);
    const aluno = (
      await master('POST', '/api/v1/invite-profiles', ALUNO)
    ).json();
    const invited = (
      await master('POST', '/api/v1/people', {
        email: 'sem-acervo@example.com',
        profileId: aluno.id,
      })
    ).json();
    await master('PATCH', `/api/v1/people/${invited.id}`, { topics: [] });
    const person = caller(
      started.app,
      await signIn(started, 'sem-acervo@example.com'),
    );
    const settings = (await person('GET', '/api/v1/settings')).json();
    expect(settings.preferences.defaultTopic).toBeUndefined();
    expect(settings.preferences.theme).toBe('dark');
  });
});
