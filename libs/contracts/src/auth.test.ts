import { describe, expect, it } from 'vitest';
import {
  actAsRequestSchema,
  DEFAULT_INVITE_FEATURES,
  inviteRequestSchema,
  meSchema,
  personSchema,
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
      media: true,
    };
    // An older API sends none: nobody acts, the account may not act as anyone, and no
    // collection has levels for it (KBC-103).
    expect(meSchema.parse(me)).toEqual({
      ...me,
      canActAs: false,
      actingAs: null,
      levels: {},
      levelsManager: false,
    });
    expect(meSchema.safeParse({ ...me, topics: ['../x'] }).success).toBe(false);
  });

  it('sends the invitation e-mail unless asked not to (KBC-026)', () => {
    expect(inviteRequestSchema.parse({ email: 'a@example.com' })).toEqual({
      email: 'a@example.com',
      sendEmail: true,
    });
    expect(
      inviteRequestSchema.parse({ email: 'a@example.com', sendEmail: false })
        .sendEmail,
    ).toBe(false);
  });

  it('reads a person from an API without invitations as never invited by e-mail', () => {
    const person = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'a@example.com',
      name: '',
      picture: null,
      role: 'member',
      topics: [],
      features: ['search'],
      isOwner: false,
      phone: null,
      invitedBy: 'owner@example.com',
      createdAt: '2026-10-26T12:00:00.000Z',
      lastLoginAt: null,
    };
    expect(personSchema.parse(person).invitation).toBeNull();
    // KBC-022: an API without the AI policy reads as the house default.
    expect(personSchema.parse(person).ai.appAi).toBe('default');
  });

  it('needs a reason of 3 to 500 characters to act as a person (KBC-060)', () => {
    expect(actAsRequestSchema.parse({ reason: '  bug  ' })).toEqual({
      reason: 'bug',
    });
    expect(actAsRequestSchema.safeParse({ reason: '  ' }).success).toBe(false);
    expect(
      actAsRequestSchema.safeParse({ reason: 'a'.repeat(501) }).success,
    ).toBe(false);
    expect(
      actAsRequestSchema.safeParse({ reason: 'bug', extra: 1 }).success,
    ).toBe(false);
  });
});
