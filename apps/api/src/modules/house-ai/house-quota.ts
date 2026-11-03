import { RESEARCH_WEIGHTS, type ResearchProfile } from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import { startOfAppDay } from '../../app-calendar.js';
import type { HouseUsagePort } from '../../ports/house-usage.js';

/**
 * Free requests the house account must still have today before a turn starts (ADR 0016):
 * about what each profile spends, so one question does not run dry halfway.
 */
export const CAPACITY_NEEDED: Readonly<Record<ResearchProfile, number>> = {
  fast: 8,
  deep: 16,
  exhaustive: 100,
};

/** Units taken by a turn that may still be given back. */
export interface Reservation {
  /** Researches left today after this one. */
  readonly remaining: number;
  /** Gives the units back (a turn that failed before any model answered). */
  refund(): Promise<void>;
}

/** The per-person daily quota of house researches (BR-3), counted in house-usage.jsonl. */
export class HouseQuota {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: {
      readonly ledger: HouseUsagePort;
      readonly now?: () => Date;
    },
  ) {}

  /** Researches left today for a person with this daily quota. */
  async remaining(principal: string, dailyLimit: number): Promise<number> {
    const used = await this.deps.ledger.unitsSince(
      principal,
      startOfAppDay(this.now()),
    );
    return Math.max(0, dailyLimit - used);
  }

  /** Takes the profile's units, or refuses with HOUSE_QUOTA_EXHAUSTED; one at a time. */
  reserve(
    principal: string,
    request: { readonly profile: ResearchProfile; readonly dailyLimit: number },
  ): Promise<Reservation> {
    const run = this.queue.then(() => this.take(principal, request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async take(
    principal: string,
    { profile, dailyLimit }: { profile: ResearchProfile; dailyLimit: number },
  ): Promise<Reservation> {
    const units = RESEARCH_WEIGHTS[profile];
    const left = await this.remaining(principal, dailyLimit);
    if (left < units)
      throw new AppError('HOUSE_QUOTA_EXHAUSTED', 'House quota spent today', {
        details: { remaining: left, dailyResearches: dailyLimit },
      });
    await this.append(principal, profile, units);
    let refunded = false;
    return {
      remaining: left - units,
      refund: async () => {
        if (refunded) return;
        refunded = true;
        await this.append(principal, profile, -units);
      },
    };
  }

  private append(principal: string, profile: ResearchProfile, units: number) {
    const ts = this.now().toISOString();
    return this.deps.ledger.append({ ts, principal, units, profile });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
