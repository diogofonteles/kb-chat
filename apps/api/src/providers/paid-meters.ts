/** One research turn's paid spend not yet in the house ledger (estimates in flight, costs). */
export interface TurnMeter {
  reserved: number;
  spent: number;
}

/**
 * The paid fallback's spend in flight, per principal (ADR 0016, BR-5): the house ledger gets a
 * turn's spend only when the turn ends, so every call of every open turn counts here until
 * then, and the monthly cap is checked against both.
 */
export class PaidMeters {
  private readonly open = new Map<string, Set<TurnMeter>>();
  private queue: Promise<unknown> = Promise.resolve();

  openTurn(principal: string): TurnMeter {
    const meter: TurnMeter = { reserved: 0, spent: 0 };
    const set = this.open.get(principal) ?? new Set<TurnMeter>();
    set.add(meter);
    this.open.set(principal, set);
    return meter;
  }

  /** Called once the turn's spend is in the ledger. */
  close(principal: string, meter: TurnMeter): void {
    const set = this.open.get(principal);
    set?.delete(meter);
    if (set?.size === 0) this.open.delete(principal);
  }

  /** Open turns of the principal (a turn is open from its start to its record). */
  openCount(principal: string): number {
    return this.open.get(principal)?.size ?? 0;
  }

  pending(principal: string): number {
    let total = 0;
    for (const meter of this.open.get(principal) ?? [])
      total += meter.reserved + meter.spent;
    return total;
  }

  /**
   * Reserves `estimate` on the meter when `fits(pending + estimate)` holds; one check at a
   * time, so parallel calls (sub-researchers, other turns) never see a stale total.
   */
  reserve(
    principal: string,
    request: {
      readonly meter: TurnMeter;
      readonly estimate: number;
      readonly fits: (pendingPlusEstimate: number) => Promise<boolean>;
    },
  ): Promise<boolean> {
    const run = this.queue.then(async () => {
      const ok = await request.fits(this.pending(principal) + request.estimate);
      if (ok) request.meter.reserved += request.estimate;
      return ok;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The call ended: its reservation becomes its real cost. */
  settle(meter: TurnMeter, change: { estimate: number; usd: number }): void {
    meter.reserved = Math.max(0, meter.reserved - change.estimate);
    meter.spent += change.usd;
  }
}
