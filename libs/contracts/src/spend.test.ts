import { describe, expect, it } from 'vitest';
import { spendTodaySchema } from './spend.js';

describe('spend contract', () => {
  it('describes today’s spend', () => {
    expect(
      spendTodaySchema.parse({ usd: 0, capUsd: 1, configured: true })
        .configured,
    ).toBe(true);
    expect(
      spendTodaySchema.safeParse({ usd: -1, capUsd: 1, configured: true })
        .success,
    ).toBe(false);
  });
});
