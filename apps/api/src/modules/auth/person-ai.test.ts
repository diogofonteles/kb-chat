import { DEFAULT_PERSON_AI } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import { MAX_AI_HISTORY, aiOf, applyAiUpdate, assignAi } from './person-ai.js';
import type { StoredPerson } from './person.js';

const person = (id: string): StoredPerson => ({
  id,
  sub: null,
  email: `${id}@example.com`,
  name: '',
  picture: null,
  role: 'member',
  topics: [],
  features: ['search'],
  invitedBy: 'owner@example.com',
  createdAt: '2026-10-26T10:00:00.000Z',
  lastLoginAt: null,
});

const context = { by: 'owner@example.com', now: '2026-10-26T12:00:00.000Z' };

describe('person AI access (KBC-022 FR-5, AC-12)', () => {
  it('reads a person saved before KBC-022 as the house default', () => {
    expect(aiOf(person('a'))).toEqual(DEFAULT_PERSON_AI);
  });

  it('records who changed the assignment and when, not the limits', () => {
    const limits = applyAiUpdate(
      DEFAULT_PERSON_AI,
      { dailyResearches: 3 },
      context,
    );
    expect(limits).toMatchObject({ dailyResearches: 3, history: [] });
    const assigned = applyAiUpdate(
      limits,
      { appAi: 'house', enforced: true },
      context,
    );
    expect(assigned.history).toEqual([
      { appAi: 'house', enforced: true, by: context.by, at: context.now },
    ]);
    expect(
      applyAiUpdate(assigned, { dailyResearches: null }, context)
        .dailyResearches,
    ).toBeNull();
  });

  it('keeps the last 50 changes', () => {
    let ai = DEFAULT_PERSON_AI;
    for (let i = 0; i < MAX_AI_HISTORY + 5; i++)
      ai = applyAiUpdate(ai, { enforced: i % 2 === 0 }, context);
    expect(ai.history).toHaveLength(MAX_AI_HISTORY);
  });

  it('assigns to the people given or to everyone, refusing unknown ids', () => {
    const people = [person('a'), person('b'), person('c')];
    const some = assignAi(people, { ids: ['a', 'c'], appAi: 'house' }, context);
    expect(some.result).toBe(2);
    expect(some.people.map((p) => aiOf(p).appAi)).toEqual([
      'house',
      'default',
      'house',
    ]);
    const all = assignAi(people, { ids: 'all', appAi: 'none' }, context);
    expect(all.people.every((p) => aiOf(p).appAi === 'none')).toBe(true);
    expect(() =>
      assignAi(people, { ids: ['zzz'], appAi: 'house' }, context),
    ).toThrow(/Unknown person/);
  });
});
