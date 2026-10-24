import { describe, expect, it } from 'vitest';
import { researchEventSchema } from './research.js';
import {
  aiTestRequestSchema,
  providerListSchema,
  settingsUpdateSchema,
  settingsViewSchema,
} from './settings.js';

describe('settings contract', () => {
  it('fills preference defaults and never carries a key in the view', () => {
    const view = settingsViewSchema.parse({
      exists: false,
      preferences: {},
      ai: {
        provider: null,
        keys: { openrouter: { set: true, last4: 'abcd' } },
        dailyCapUsd: 1,
      },
    });
    expect(view.preferences).toEqual({
      searchMode: 'all',
      theme: 'auto',
      defaultView: 'research',
    });
    expect(
      settingsViewSchema.safeParse({
        ...view,
        ai: { ...view.ai, keys: { openrouter: 'sk-full-key' } },
      }).success,
    ).toBe(false);
  });

  it('accepts partial updates, null removals, and refuses unknown fields', () => {
    expect(
      settingsUpdateSchema.parse({
        ai: { keys: { anthropic: null }, model: null },
        preferences: { defaultTopic: null },
      }),
    ).toEqual({
      ai: { keys: { anthropic: null }, model: null },
      preferences: { defaultTopic: null },
    });
    expect(
      settingsUpdateSchema.safeParse({ ai: { keys: { gemini: 'x' } } }).success,
    ).toBe(false);
    expect(
      settingsUpdateSchema.safeParse({ ai: { keys: { openai: 'short' } } })
        .success,
    ).toBe(false);
    expect(settingsUpdateSchema.safeParse({ theme: 'dark' }).success).toBe(
      false,
    );
  });

  it('tests every provider except "none", and lists "stub" as active only', () => {
    expect(aiTestRequestSchema.safeParse({ provider: 'none' }).success).toBe(
      false,
    );
    expect(
      aiTestRequestSchema.parse({ provider: 'claude-subscription' }),
    ).toEqual({
      provider: 'claude-subscription',
    });
    expect(providerListSchema.parse({ items: [], active: 'stub' }).active).toBe(
      'stub',
    );
  });

  it('carries a subscription turn as research events', () => {
    expect(
      researchEventSchema.parse({
        type: 'done',
        usd: 0,
        model: 'claude-code',
        interrupted: false,
        steps: 2,
      }),
    ).toMatchObject({ usd: 0 });
  });
});
