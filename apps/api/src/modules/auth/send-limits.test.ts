import { describe, expect, it } from 'vitest';
import { SendLimits } from './send-limits.js';

function setup() {
  let now = 0;
  return {
    limits: new SendLimits({ now: () => now }),
    advance: (ms: number) => (now += ms),
  };
}

describe('SendLimits (KBC-014 BR-5)', () => {
  it('allows one send per minute per identifier', () => {
    const { limits, advance } = setup();
    const ana = {
      purpose: 'login' as const,
      identifier: 'ana@example.com',
      ip: '10.0.0.1',
    };

    expect(limits.take(ana)).toBe(true);
    expect(limits.take(ana)).toBe(false);
    advance(60_000);
    expect(limits.take(ana)).toBe(true);
  });

  it('allows five sends per hour per identifier', () => {
    const { limits, advance } = setup();
    const results: boolean[] = [];
    for (let minute = 0; minute < 6; minute += 1) {
      results.push(
        limits.take({
          purpose: 'login',
          identifier: 'ana@example.com',
          ip: `10.0.0.${minute}`,
        }),
      );
      advance(60_000);
    }
    expect(results).toEqual([true, true, true, true, true, false]);
    advance(3600_000);
    expect(
      limits.take({
        purpose: 'login',
        identifier: 'ana@example.com',
        ip: '10.0.0.9',
      }),
    ).toBe(true);
  });

  it('allows five sends per minute and twenty per hour from one address', () => {
    const { limits, advance } = setup();
    const fromOneIp = (n: number) =>
      limits.take({
        purpose: 'login',
        identifier: `p${n}@example.com`,
        ip: '10.0.0.1',
      });
    const minute = [1, 2, 3, 4, 5, 6].map(fromOneIp);
    expect(minute).toEqual([true, true, true, true, true, false]);

    let accepted = 5;
    for (let n = 10; n < 40; n += 1) {
      advance(60_000);
      if (fromOneIp(n)) accepted += 1;
    }
    expect(accepted).toBe(20);
  });

  it('counts sign-up and sign-in codes of one email apart', () => {
    const { limits } = setup();
    const email = 'ana@example.com';
    expect(
      limits.take({ purpose: 'signup', identifier: email, ip: '1.1.1.1' }),
    ).toBe(true);
    expect(
      limits.take({ purpose: 'login', identifier: email, ip: '1.1.1.1' }),
    ).toBe(true);
    expect(
      limits.take({ purpose: 'login', identifier: email, ip: '1.1.1.2' }),
    ).toBe(false);
  });

  it('records nothing when refused, so the other key keeps its budget', () => {
    const { limits } = setup();
    expect(
      limits.take({ purpose: 'login', identifier: 'a@x.co', ip: '1.1.1.1' }),
    ).toBe(true);
    expect(
      limits.take({ purpose: 'login', identifier: 'a@x.co', ip: '2.2.2.2' }),
    ).toBe(false);
    expect(
      limits.take({ purpose: 'login', identifier: 'b@x.co', ip: '2.2.2.2' }),
    ).toBe(true);
  });
});
