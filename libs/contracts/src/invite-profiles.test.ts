import { describe, expect, it } from 'vitest';
import {
  invitationPresetSchema,
  invitePresetSchema,
  inviteProfileViewSchema,
  presetInviteRequestSchema,
} from './invite-profiles.js';

describe('invite presets (KBC-028)', () => {
  it('fills a plain invitation’s defaults', () => {
    expect(invitePresetSchema.parse({})).toEqual({
      role: 'member',
      topics: [],
      features: ['search'],
      ai: {
        appAi: 'default',
        enforced: false,
        dailyResearches: null,
        paidFallback: { enabled: false, monthlyCapUsd: 1 },
      },
      preferences: {},
    });
  });

  it('never lends a subscription (BR-2)', () => {
    for (const appAi of ['claude-subscription', 'chatgpt-subscription'])
      expect(invitePresetSchema.safeParse({ ai: { appAi } }).success).toBe(
        false,
      );
    expect(
      invitePresetSchema.safeParse({ ai: { appAi: 'house' } }).success,
    ).toBe(true);
  });

  it('keeps the default collection among the granted ones, unless master (BR-4)', () => {
    const preferences = { defaultTopic: 'hermetismo' };
    expect(invitePresetSchema.safeParse({ preferences }).success).toBe(false);
    expect(
      invitePresetSchema.safeParse({ topics: ['hermetismo'], preferences })
        .success,
    ).toBe(true);
    expect(
      invitePresetSchema.safeParse({ role: 'master', preferences }).success,
    ).toBe(true);
  });

  it('takes a preset or a profile, not both', () => {
    expect(
      presetInviteRequestSchema.safeParse({
        email: 'a@b.com',
        preset: {},
        profileId: '6c9c2a1e-6b1e-4f8e-9d55-0f3a1d9b2c11',
      }).success,
    ).toBe(false);
  });

  it('lends a subscription in one invitation only with the terms (KBC-031 BR-2, BR-3)', () => {
    for (const appAi of ['claude-subscription', 'chatgpt-subscription']) {
      expect(invitationPresetSchema.safeParse({ ai: { appAi } }).success).toBe(
        false,
      );
      const lent = invitationPresetSchema.parse({
        ai: { appAi, subscriptionTermsAccepted: true },
      });
      expect(lent.ai).toMatchObject({ appAi, subscriptionTermsAccepted: true });
    }
    expect(
      invitationPresetSchema.safeParse({
        preferences: { defaultTopic: 'hermetismo' },
      }).success,
    ).toBe(false);
  });
});

describe('levels in presets (KBC-109)', () => {
  it('keeps the levels of a member preset and leaves the key out when none is sent', () => {
    expect(
      invitePresetSchema.parse({
        topics: ['hermetismo'],
        levels: { hermetismo: 'ci' },
      }).levels,
    ).toEqual({ hermetismo: 'ci' });
    expect('levels' in invitePresetSchema.parse({})).toBe(false);
  });

  it('refuses levels on a master preset (BR-5), in a profile and in an invitation', () => {
    const master = { role: 'master', levels: { hermetismo: 'ci' } };
    expect(invitePresetSchema.safeParse(master).success).toBe(false);
    expect(invitationPresetSchema.safeParse(master).success).toBe(false);
    expect(
      invitePresetSchema.safeParse({ role: 'master', levels: {} }).success,
    ).toBe(true);
  });

  it('reads a profile with no stale levels as an empty map', () => {
    const profile = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Aluno',
      preset: invitePresetSchema.parse({}),
      isDefault: false,
    };
    expect(inviteProfileViewSchema.parse(profile).staleLevels).toEqual({});
  });
});
