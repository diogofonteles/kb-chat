import { describe, expect, it } from 'vitest';
import {
  codeRequestSchema,
  googleAccessRequestSchema,
  notInvitedDetailsSchema,
  oneTimeCodeSchema,
  signUpRequestSchema,
} from './access.js';

describe('access contracts (KBC-014)', () => {
  it('normalizes the sign-up phone and trims the names', () => {
    expect(
      signUpRequestSchema.parse({
        email: 'ana@example.com',
        firstName: ' Ana ',
        lastName: 'Lima',
        phone: '(81) 99999-0000',
      }),
    ).toEqual({
      email: 'ana@example.com',
      firstName: 'Ana',
      lastName: 'Lima',
      phone: '+5581999990000',
    });
  });

  it('refuses a sign-up without a name or with a bad phone', () => {
    const base = {
      email: 'ana@example.com',
      firstName: 'Ana',
      lastName: 'Lima',
      phone: '81999990000',
    };
    expect(
      signUpRequestSchema.safeParse({ ...base, lastName: ' ' }).success,
    ).toBe(false);
    expect(
      signUpRequestSchema.safeParse({ ...base, phone: '123' }).success,
    ).toBe(false);
  });

  it('takes exactly six digits as a code', () => {
    expect(oneTimeCodeSchema.safeParse('012345').success).toBe(true);
    for (const code of ['12345', '1234567', '12a456'])
      expect(oneTimeCodeSchema.safeParse(code).success).toBe(false);
  });

  it('lets the Google request leave the phone out', () => {
    expect(googleAccessRequestSchema.parse({ ticket: 'x'.repeat(40) })).toEqual(
      { ticket: 'x'.repeat(40) },
    );
  });

  it('describes a refused request with the time it may be made again', () => {
    expect(
      notInvitedDetailsSchema.safeParse({
        ticket: 't',
        request: { status: 'refused', retryAt: '2026-10-26T10:00:00.000Z' },
      }).success,
    ).toBe(true);
    expect(
      codeRequestSchema.safeParse({ identifier: 'a@b.co', channel: 'fax' })
        .success,
    ).toBe(false);
  });
});
