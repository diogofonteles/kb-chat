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

/** The pieces of one running turn, made only when it starts (no state for a mere check). */
export interface HouseTurn {
  /** The tool loop over the house model, spending on the house ledger. */
  readonly inner: ResearchRunnerPort;
  /** The person's paid fallback can answer when the free requests run out. */
  readonly paidActive: boolean;
  /** Runs once the turn is over, whatever its end. */
  readonly finish: () => void;
}

/** Which app AI a runner serves: the house plan, or the owner's lent subscription (KBC-024). */
export type AppPlan = 'house' | 'app-subscription' | 'app-chatgpt-subscription';

export interface HouseRunnerDeps {
  /** Default `house`: billed free or per token; `app-subscription`: by the subscription. */
  readonly plan?: AppPlan;
  /** The house model as it stands now: its name and whether it can answer. */
  readonly preview: ResearchRunnerPort;
  readonly quota: HouseQuota;
  readonly principal: string;
  readonly dailyLimit: number;
  /** Today's free requests of the house account; null when unknown (then not checked). */
  readonly capacity: () => Promise<FreeUsage | null>;
  /** Loads what the chain needs (the live list, the person's key) before the turn. */
  readonly prepare?: () => Promise<void>;
  /** Builds the turn after `prepare`, with the person's current key. */
  readonly startTurn: () => HouseTurn;
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
 * A research turn on an app AI (KBC-022, KBC-024): the person's daily quota and the house
 * account's free capacity are checked first; the answer says who paid, what it cost and how
 * many researches are left today.
 */
export class HouseResearchRunner implements ResearchRunnerPort {
  constructor(private readonly deps: HouseRunnerDeps) {}

  get billing(): 'free' | 'subscription' {
    return this.plan === 'house' ? 'free' : 'subscription';
  }

  private get plan(): AppPlan {
    return this.deps.plan ?? 'house';
  }

  get model(): string {
    return this.deps.preview.model;
  }

  configured(): boolean {
    return this.deps.preview.configured();
  }

  async *run(input: ResearchInput): AsyncIterable<ResearchEvent> {
    await this.deps.prepare?.();
    const turn = this.deps.startTurn();
    try {
      yield* this.turn(input, turn);
    } finally {
      turn.finish();
    }
  }

  private async *turn(
    input: ResearchInput,
    turn: HouseTurn,
  ): AsyncIterable<ResearchEvent> {
    const refusal = await this.capacityRefusal(input.profile, turn.paidActive);
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
      const code = err instanceof AppError ? err.code : 'INTERNAL';
      yield code === 'HOUSE_QUOTA_EXHAUSTED'
        ? { type: 'error', code, limit: this.deps.dailyLimit }
        : { type: 'error', code };
      return;
    }
    yield* this.relay({ input, reservation, inner: turn.inner });
  }

  private async *relay({
    input,
    reservation,
    inner,
  }: {
    input: ResearchInput;
    reservation: Reservation;
    inner: ResearchRunnerPort;
  }): AsyncIterable<ResearchEvent> {
    let answered = false;
    for await (const event of inner.run(input)) {
      answered ||= ANSWERED.has(event.type);
      if (event.type === 'error' && !answered) await reservation.refund();
      yield event.type === 'done' ? this.labelled(event, reservation) : event;
    }
  }

  private labelled(done: Done, reservation: Reservation): Done {
    const billing =
      this.plan !== 'house'
        ? 'subscription'
        : done.usd === 0
          ? 'free'
          : 'per-token';
    return {
      ...done,
      billing,
      plan: this.plan,
      remaining: reservation.remaining,
    };
  }

  /** Not enough free requests left today for this profile (and no paid fallback). */
  private async capacityRefusal(
    profile: ResearchProfile,
    paidActive: boolean,
  ): Promise<'AI_CAPACITY_EXHAUSTED' | null> {
    if (paidActive) return null;
    const usage = await this.deps.capacity();
    return usage && usage.remaining < CAPACITY_NEEDED[profile]
      ? 'AI_CAPACITY_EXHAUSTED'
      : null;
  }
}
