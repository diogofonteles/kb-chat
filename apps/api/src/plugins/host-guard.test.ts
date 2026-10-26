import { describe, expect, it } from 'vitest';
import { hostnameOf } from './host-guard.js';

describe('hostnameOf', () => {
  it('strips ports, keeps IPv6 brackets and handles a missing header', () => {
    expect(hostnameOf('localhost:3000')).toBe('localhost');
    expect(hostnameOf('[::1]:3000')).toBe('[::1]');
    expect(hostnameOf(undefined)).toBe('');
  });
});
