import { describe, expect, it } from 'vitest';
import {
  invitePresetSchema,
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
});
