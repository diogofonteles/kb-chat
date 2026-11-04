import { describe, expect, it } from 'vitest';
import { voiceListState } from './voice-list-state.js';

const OLDEST = '2026-10-01T00:00:00.000Z';
const NONE = { ids: [], complete: false, startedAt: null };
const MARKED = { ...NONE, complete: true };

describe('voiceListState (ADR 0032 §4)', () => {
  it('no consent and no list is nothing lost', () => {
    expect(voiceListState(NONE, null)).toBe('unused');
  });

  it('a consent and no list is a lost list', () => {
    expect(voiceListState(NONE, OLDEST)).toBe('lost');
  });

  it("the owner's mark vouches for any consent", () => {
    expect(voiceListState(MARKED, OLDEST)).toBe('whole');
  });

  it('a list started at the first consent vouches for it', () => {
    const list = { ...MARKED, startedAt: OLDEST };
    expect(voiceListState(list, OLDEST)).toBe('whole');
  });

  it('a list younger than a consent never saw its revocation', () => {
    const list = { ...MARKED, startedAt: '2026-10-01T00:00:00.001Z' };
    expect(voiceListState(list, OLDEST)).toBe('lost');
  });

  it('a list with no consent left is still a list', () => {
    expect(voiceListState(MARKED, null)).toBe('whole');
  });
});
