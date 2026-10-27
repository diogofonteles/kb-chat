import { afterEach, describe, expect, it } from 'vitest';
import {
  caller,
  closeApp,
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
});
