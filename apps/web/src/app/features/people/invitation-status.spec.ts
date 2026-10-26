import { HttpErrorResponse } from '@angular/common/http';
import { DEFAULT_PERSON_AI, type Person } from '@kb-chat/contracts';
import { invitationLimitOf, invitationStateOf } from './invitation-status.js';

const person = (overrides: Partial<Person>): Person => ({
  id: '11111111-1111-4111-8111-111111111111',
  email: 'guest@example.com',
  name: '',
  picture: null,
  role: 'member',
  topics: [],
  features: ['search'],
  isOwner: false,
  phone: null,
  invitation: null,
  invitedBy: 'owner@example.com',
  createdAt: '2026-10-26T12:00:00.000Z',
  lastLoginAt: null,
  ai: DEFAULT_PERSON_AI,
  ...overrides,
});

describe('invitationStateOf (KBC-026 AC-3)', () => {
  it('is active after the first sign-in, whatever the invitation says', () => {
    expect(
      invitationStateOf(
        person({
          lastLoginAt: '2026-10-26T13:00:00.000Z',
          invitation: { sentAt: null, failedAt: '2026-10-26T12:00:00.000Z' },
        }),
      ),
    ).toEqual({ kind: 'active', at: '2026-10-26T13:00:00.000Z' });
  });

  it('shows a failure before an earlier success, then the sent date', () => {
    expect(
      invitationStateOf(
        person({
          invitation: {
            sentAt: '2026-10-26T12:00:00.000Z',
            failedAt: '2026-10-26T12:30:00.000Z',
          },
        }),
      ),
    ).toEqual({ kind: 'failed', at: '2026-10-26T12:30:00.000Z' });
    expect(
      invitationStateOf(
        person({
          invitation: { sentAt: '2026-10-26T12:00:00.000Z', failedAt: null },
        }),
      ),
    ).toEqual({ kind: 'sent', at: '2026-10-26T12:00:00.000Z' });
  });

  it('has no invitation for people invited without e-mail or before KBC-026', () => {
    expect(invitationStateOf(person({}))).toEqual({ kind: 'none' });
  });
});

describe('invitationLimitOf (KBC-026 AC-4)', () => {
  const limited = (details: unknown) =>
    new HttpErrorResponse({
      status: 429,
      error: { error: { code: 'RATE_LIMITED', message: 'x', details } },
    });

  it('reads when the invitation may be sent again', () => {
    expect(
      invitationLimitOf(limited({ retryAt: '2026-10-26T12:10:00.000Z' })),
    ).toBe('2026-10-26T12:10:00.000Z');
  });

  it('is null for any other failure', () => {
    expect(invitationLimitOf(limited(undefined))).toBeNull();
    expect(invitationLimitOf(new Error('x'))).toBeNull();
    expect(
      invitationLimitOf(new HttpErrorResponse({ status: 0, error: null })),
    ).toBeNull();
  });
});
