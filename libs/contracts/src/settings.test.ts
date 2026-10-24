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
        models: {},
        keys: { openrouter: { set: true, last4: 'abcd' } },
        dailyCapUsd: 1,
      },
    });
    expect(view.preferences).toEqual({
      searchMode: 'all',
      theme: 'auto',
      defaultView: 'research',
      researchProfile: 'fast',
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
        ai: {
          keys: { anthropic: null },
          models: { anthropic: { fast: null } },
        },
        preferences: { defaultTopic: null },
      }),
    ).toEqual({
      ai: { keys: { anthropic: null }, models: { anthropic: { fast: null } } },
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

  it('accepts model ids and aliases and refuses values a CLI could read as a flag', () => {
    const update = (provider: string, model: string) =>
      settingsUpdateSchema.safeParse({
        ai: { models: { [provider]: { deep: model } } },
      }).success;
    for (const model of ['deepseek/deepseek-v4-pro', 'gpt-5.5', 'm@v1:x'])
      expect(update('openrouter', model)).toBe(true);
    for (const model of ['--dangerously-skip-permissions', '-x', 'a b', 'a;b'])
      expect(update('openrouter', model)).toBe(false);
    // A subscription CLI takes only its own aliases and ids (KBC-011).
    for (const model of ['sonnet', 'opus', 'haiku', 'claude-opus-5-5'])
      expect(update('claude-subscription', model)).toBe(true);
    for (const model of ['gpt-5.5', 'deepseek/deepseek-v4-pro'])
      expect(update('claude-subscription', model)).toBe(false);
    expect(
      aiTestRequestSchema.safeParse({
        provider: 'claude-subscription',
        model: 'gpt-5.5',
      }).success,
    ).toBe(false);
    expect(
      aiTestRequestSchema.safeParse({ provider: 'openai', model: '-p' })
        .success,
    ).toBe(false);
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
        billing: 'subscription',
        model: 'claude-code',
        interrupted: false,
        steps: 2,
      }),
    ).toMatchObject({ usd: 0, billing: 'subscription' });
  });
});
