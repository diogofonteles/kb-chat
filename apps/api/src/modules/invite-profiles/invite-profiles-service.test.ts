import { describe, expect, it, vi } from 'vitest';
import { MemoryDocumentStore } from '../../adapters/memory-document-store.js';
import { InviteProfilesService } from './invite-profiles-service.js';

const ID = '00000000-0000-4000-8000-000000000001';

const stored = (features: string[]) => ({
  version: 1,
  profiles: [
    {
      id: ID,
      name: 'Aluno',
      isDefault: true,
      preset: {
        role: 'member',
        topics: ['hermetismo'],
        features,
        ai: {
          appAi: 'default',
          enforced: false,
          dailyResearches: null,
          paidFallback: { enabled: false, monthlyCapUsd: 1 },
        },
        preferences: {},
      },
    },
  ],
});

describe('InviteProfilesService (KBC-109)', () => {
  it('loads a profile naming a feature this image does not know, without it, and warns', async () => {
    const store = new MemoryDocumentStore();
    await store.write(stored(['search', 'a-feature-from-the-future']));
    const warn = vi.fn();
    const profiles = new InviteProfilesService({ store, warn });

    await profiles.load();

    expect(profiles.find(ID).preset.features).toEqual(['search']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('a-feature-from-the-future'),
    );
    await profiles.update(ID, { name: 'Aluna' });
    expect(profiles.find(ID).name).toBe('Aluna');
  });

  it('writes no levels key for a preset without levels, and keeps the levels given', async () => {
    const store = new MemoryDocumentStore();
    const profiles = new InviteProfilesService({ store, newId: () => ID });
    await profiles.load();

    await profiles.create({ name: 'Sem', preset: { levels: {} } });
    expect(JSON.stringify(await store.read())).not.toContain('"levels"');

    await profiles.update(ID, {
      preset: { topics: ['hermetismo'], levels: { hermetismo: 'ci' } },
    });
    expect(profiles.find(ID).preset.levels).toEqual({ hermetismo: 'ci' });
  });

  it('keeps an unreadable file as it is, with profiles off', async () => {
    const store = new MemoryDocumentStore();
    await store.write({ version: 1, profiles: [{ id: 'nope' }] });
    const warn = vi.fn();
    const profiles = new InviteProfilesService({ store, warn });
    await profiles.load();
    expect(profiles.list()).toEqual([]);
    await expect(profiles.create({ name: 'X', preset: {} })).rejects.toThrow();
  });
});
