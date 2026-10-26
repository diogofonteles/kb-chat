import { describe, expect, it } from 'vitest';
import { normalizePhone, phoneSchema } from './phone.js';

describe('normalizePhone (KBC-014 BR-8)', () => {
  it('adds +55 to a Brazilian number typed with DDD and punctuation', () => {
    expect(normalizePhone('(81) 99999-0000')).toBe('+5581999990000');
    expect(normalizePhone('81 3333-4444')).toBe('+558133334444');
  });

  it('keeps an international number that starts with +', () => {
    expect(normalizePhone('+1 415 555 2671')).toBe('+14155552671');
    expect(normalizePhone('+55 (81) 99999-0000')).toBe('+5581999990000');
  });

  it('drops the trunk zero of a Brazilian long-distance number', () => {
    expect(normalizePhone('081 99999-0000')).toBe('+5581999990000');
  });

  it('accepts the country code without the plus sign', () => {
    expect(normalizePhone('5581999990000')).toBe('+5581999990000');
  });

  it('refuses what cannot be a phone number', () => {
    for (const input of [
      '',
      'abc',
      '9999',
      '+0 123456789',
      '+1234567890123456',
    ])
      expect(normalizePhone(input)).toBeNull();
  });

  it('validates and normalizes inside a schema', () => {
    expect(phoneSchema.parse('(81) 99999-0000')).toBe('+5581999990000');
    expect(phoneSchema.safeParse('12').success).toBe(false);
  });
});
