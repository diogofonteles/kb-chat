import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INVITE_FEATURES,
  meSchema,
  personUpdateSchema,
} from './auth.js';

describe('auth contracts', () => {
  it('defaults a new invite to search only (BR-3)', () => {
    expect(DEFAULT_INVITE_FEATURES).toEqual(['search']);
  });

  it('accepts a partial person update and refuses an unknown feature', () => {
    expect(personUpdateSchema.parse({ role: 'master' })).toEqual({
      role: 'master',
    });
    expect(personUpdateSchema.safeParse({ features: ['admin'] }).success).toBe(
      false,
    );
  });

  it('describes who is signed in with visible collections as slugs', () => {
    const me = {
      email: 'a@example.com',
      name: 'A',
      picture: null,
      role: 'member',
      features: ['search'],
      topics: ['hermetismo'],
      isOwner: false,
    };
    expect(meSchema.parse(me)).toEqual(me);
    expect(meSchema.safeParse({ ...me, topics: ['../x'] }).success).toBe(false);
  });
});
