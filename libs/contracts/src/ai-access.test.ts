import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERSON_AI,
  RESEARCH_WEIGHTS,
  aiAssignmentRequestSchema,
  personAiUpdateSchema,
} from './ai-access.js';
import { savedResearchTurnSchema } from './conversations.js';
import { houseAiUpdateSchema, houseAiViewSchema } from './house-ai.js';
import { personUpdateSchema } from './auth.js';
import { researchEventSchema } from './research.js';

describe('AI access policy contracts (KBC-022)', () => {
  it('weighs the profiles 1, 2 and 5 and starts people on the house default', () => {
    expect(RESEARCH_WEIGHTS).toEqual({ fast: 1, deep: 2, exhaustive: 5 });
    expect(DEFAULT_PERSON_AI).toMatchObject({
      appAi: 'default',
      enforced: false,
      dailyResearches: null,
    });
  });

  it('accepts one, several or every person, the default only with an AI', () => {
    expect(
      aiAssignmentRequestSchema.parse({ personIds: 'all', appAi: 'none' })
        .setDefault,
    ).toBe(false);
    expect(
      aiAssignmentRequestSchema.safeParse({ personIds: [], appAi: 'house' })
        .success,
    ).toBe(false);
    expect(
      aiAssignmentRequestSchema.safeParse({ personIds: 'some', appAi: 'house' })
        .success,
    ).toBe(false);
  });

  it('bounds the quota and the monthly cap, and refuses unknown fields', () => {
    expect(
      personAiUpdateSchema.safeParse({ dailyResearches: -1 }).success,
    ).toBe(false);
    expect(
      personAiUpdateSchema.safeParse({
        paidFallback: { enabled: true, monthlyCapUsd: 101 },
      }).success,
    ).toBe(false);
    expect(
      personAiUpdateSchema.safeParse({ appAi: 'house', extra: 1 }).success,
    ).toBe(false);
    expect(personUpdateSchema.parse({ ai: { appAi: 'none' } }).ai?.appAi).toBe(
      'none',
    );
  });

  it('never carries a house key back, only its last 4', () => {
    const view = houseAiViewSchema.parse({
      connection: {
        key: { set: true, last4: 'wxyz' },
        via: 'oauth',
        connectedAt: '2026-10-26T10:00:00.000Z',
        connectedBy: 'o@x.com',
      },
      freeModels: null,
      includeRouter: true,
      chain: ['a:free'],
      paidModel: null,
      defaultAppAi: 'house',
      defaultChange: null,
      defaultDailyResearches: 5,
      managementKey: null,
      freeUsage: null,
      lendable: {
        'claude-subscription': false,
        'chatgpt-subscription': false,
      },
      codex: { configured: false, enabled: false, loggedIn: null },
      key: 'sk-or-leak',
    });
    expect(JSON.stringify(view)).not.toContain('sk-or-leak');
    expect(houseAiUpdateSchema.safeParse({ key: 'short' }).success).toBe(false);
  });

  it('lends a subscription only with its terms confirmed and never as the default (KBC-024)', () => {
    expect(
      personAiUpdateSchema.safeParse({ appAi: 'claude-subscription' }).success,
    ).toBe(false);
    expect(
      personAiUpdateSchema.safeParse({
        appAi: 'claude-subscription',
        subscriptionTermsAccepted: true,
      }).success,
    ).toBe(true);
    expect(
      aiAssignmentRequestSchema.safeParse({
        personIds: 'all',
        appAi: 'claude-subscription',
        subscriptionTermsAccepted: true,
        setDefault: true,
      }).success,
    ).toBe(false);
    expect(
      houseAiUpdateSchema.safeParse({ defaultAppAi: 'claude-subscription' })
        .success,
    ).toBe(false);
    expect(
      researchEventSchema.parse({
        type: 'done',
        usd: 0,
        billing: 'subscription',
        model: 'sonnet',
        interrupted: false,
        steps: 1,
        plan: 'app-subscription',
      }),
    ).toMatchObject({ plan: 'app-subscription' });
  });

  it('marks free answers, who paid and the researches left, in events and saved turns', () => {
    const done = researchEventSchema.parse({
      type: 'done',
      usd: 0,
      billing: 'free',
      model: 'a:free',
      interrupted: false,
      steps: 2,
      plan: 'house',
      remaining: 4,
    });
    expect(done).toMatchObject({
      billing: 'free',
      plan: 'house',
      remaining: 4,
    });
    const turn = savedResearchTurnSchema.parse({
      question: 'q',
      answer: 'a',
      sources: [],
      steps: 1,
      usd: 0,
      billing: 'free',
      model: 'a:free',
      interrupted: false,
      plan: 'house',
      at: '2026-10-26T10:00:00.000Z',
    });
    expect(turn.plan).toBe('house');
  });
});
