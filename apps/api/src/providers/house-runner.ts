import type {
  FreeUsage,
  ResearchEvent,
  ResearchProfile,
} from '@kb-chat/contracts';
import type {
  ResearchInput,
  ResearchRunnerPort,
} from '../ports/research-runner.js';
import { AppError } from '../app-error.js';
import {
  CAPACITY_NEEDED,
  type HouseQuota,
  type Reservation,
} from '../modules/house-ai/index.js';

export interface HouseRunnerDeps {
  /** The tool loop over the house model, spending on the house ledger. */
  readonly inner: ResearchRunnerPort;
  readonly quota: HouseQuota;
  readonly principal: string;
  readonly dailyLimit: number;
  /** Today's free requests of the house account; null when unknown (then not checked). */
  readonly capacity: () => Promise<FreeUsage | null>;
  /** The person's paid fallback can answer when the free requests run out. */
  readonly paidActive: boolean;
  /** Loads what the chain needs (the live free-model list) before the first call. */
  readonly prepare?: () => Promise<void>;
}

type Done = Extract<ResearchEvent, { type: 'done' }>;

/** Events that show a model already answered: the turn's units are not given back. */
const ANSWERED = new Set<ResearchEvent['type']>([
  'token',
  'step',
  'sources',
  'retract',
]);

/**
 * A research turn on the house plan (KBC-022): the person's daily quota and the account's
 * free capacity are checked first; the answer says it was free (or its cost) and how many
 * researches are left today.
 */
export class HouseResearchRunner implements ResearchRunnerPort {
  readonly billing = 'free' as const;

  constructor(private readonly deps: HouseRunnerDeps) {}

  get model(): string {
    return this.deps.inner.model;
  }

  configured(): boolean {
    return this.deps.inner.configured();
  }

  async *run(input: ResearchInput): AsyncIterable<ResearchEvent> {
    await this.deps.prepare?.();
    const refusal = await this.capacityRefusal(input.profile);
    if (refusal) {
      yield { type: 'error', code: refusal };
      return;
    }
    let reservation: Reservation;
    try {
      reservation = await this.deps.quota.reserve(this.deps.principal, {
        profile: input.profile,
        dailyLimit: this.deps.dailyLimit,
      });
    } catch (err) {
      yield {
        type: 'error',
        code: err instanceof AppError ? err.code : 'INTERNAL',
      };
      return;
    }
    yield* this.relay(input, reservation);
  }

  private async *relay(
    input: ResearchInput,
    reservation: Reservation,
  ): AsyncIterable<ResearchEvent> {
    let answered = false;
    for await (const event of this.deps.inner.run(input)) {
      answered ||= ANSWERED.has(event.type);
      if (event.type === 'error' && !answered) await reservation.refund();
      yield event.type === 'done' ? this.labelled(event, reservation) : event;
    }
  }

  private labelled(done: Done, reservation: Reservation): Done {
    return {
      ...done,
      billing: done.usd === 0 ? 'free' : 'per-token',
      plan: 'house',
      remaining: reservation.remaining,
    };
  }

  /** Not enough free requests left today for this profile (and no paid fallback). */
  private async capacityRefusal(
    profile: ResearchProfile,
  ): Promise<'AI_CAPACITY_EXHAUSTED' | null> {
    if (this.deps.paidActive) return null;
    const usage = await this.deps.capacity();
    return usage && usage.remaining < CAPACITY_NEEDED[profile]
      ? 'AI_CAPACITY_EXHAUSTED'
      : null;
  }
}
