import { describe, expect, it } from 'vitest';
import { PaidMeters } from './paid-meters.js';

/** A cap check like the house's: ledger spend (fixed here) + in flight + estimate ≤ cap. */
const capOf =
  (cap: number, ledger = 0) =>
  async (pendingPlusEstimate: number) =>
    ledger + pendingPlusEstimate <= cap;

describe('PaidMeters (KBC-022 BR-5, review fix)', () => {
  it('counts the calls of an open turn until the cap, before the ledger knows them', async () => {
    const meters = new PaidMeters();
    const turn = meters.openTurn('p');
    const call = (estimate: number) =>
      meters.reserve('p', { meter: turn, estimate, fits: capOf(1, 0.5) });
    expect(await call(0.2)).toBe(true);
    meters.settle(turn, { estimate: 0.2, usd: 0.25 });
    expect(await call(0.2)).toBe(true);
    meters.settle(turn, { estimate: 0.2, usd: 0.2 });
    // 0.5 in the ledger + 0.45 spent this turn: another 0.2 would pass the cap.
    expect(await call(0.2)).toBe(false);
    expect(meters.pending('p')).toBeCloseTo(0.45);
    meters.close('p', turn);
    expect(meters.pending('p')).toBe(0);
  });

  it('serializes parallel reservations across turns of the same person', async () => {
    const meters = new PaidMeters();
    const a = meters.openTurn('p');
    const b = meters.openTurn('p');
    const results = await Promise.all([
      meters.reserve('p', { meter: a, estimate: 0.6, fits: capOf(1) }),
      meters.reserve('p', { meter: b, estimate: 0.6, fits: capOf(1) }),
    ]);
    expect(results).toEqual([true, false]);
    expect(meters.pending('q')).toBe(0);
  });
});
