import { describe, expect, it } from 'vitest';
import { effectiveFeatures, hasFeature, type StoredPerson } from './person.js';

const person = (over: Partial<StoredPerson>): StoredPerson => ({
  id: '11111111-1111-4111-8111-111111111111',
  sub: null,
  email: 'pessoa@example.com',
  name: '',
  picture: null,
  role: 'member',
  topics: [],
  features: [],
  invitedBy: 'owner@example.com',
  createdAt: '2026-11-04T10:00:00.000Z',
  lastLoginAt: null,
  ...over,
});

describe('hasFeature (ADR 0032)', () => {
  const stale = person({ features: ['search', 'media-voice-profiles'] });

  it('gives a member what was granted, and nothing else', () => {
    expect(hasFeature(stale, 'search')).toBe(true);
    expect(hasFeature(stale, 'research')).toBe(false);
  });

  it('ignores a master-only feature on a stored member list', () => {
    expect(hasFeature(stale, 'media-voice-profiles')).toBe(false);
    expect(effectiveFeatures(stale)).toEqual(['search']);
  });

  it('gives a master every feature, with an empty list', () => {
    const master = person({ role: 'master' });
    expect(hasFeature(master, 'media-voice-profiles')).toBe(true);
  });
});
