import { z } from 'zod';

/** E.164: a plus, a country code that does not start with 0, at most 15 digits in all. */
const E164 = /^\+[1-9]\d{7,14}$/;
/** Brazil (KBC-014 BR-8): the country code a number without one gets. */
const DEFAULT_COUNTRY_CODE = '55';
/** DDD + number: 10 digits for a landline, 11 for a mobile. */
const BRAZILIAN_NATIONAL_LENGTHS = new Set([10, 11]);

function withCountryCode(digits: string): string {
  const national = digits.replace(/^0/, '');
  return BRAZILIAN_NATIONAL_LENGTHS.has(national.length)
    ? `+${DEFAULT_COUNTRY_CODE}${national}`
    : `+${digits}`;
}

/**
 * The E.164 form of a phone number as people type it ("(81) 99999-0000" → "+5581999990000"),
 * or null when it cannot be one. Without a leading "+", a 10 or 11 digit number is Brazilian.
 */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 0) return null;
  const candidate = trimmed.startsWith('+')
    ? `+${digits}`
    : withCountryCode(digits);
  return E164.test(candidate) ? candidate : null;
}

/** A phone number in any common notation, parsed to E.164. */
export const phoneSchema = z
  .string()
  .max(32)
  .transform((value, context) => {
    const phone = normalizePhone(value);
    if (phone === null) {
      context.addIssue({ code: 'custom', message: 'Invalid phone number' });
      return z.NEVER;
    }
    return phone;
  });
