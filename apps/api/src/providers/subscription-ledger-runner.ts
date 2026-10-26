import type { ResearchEvent } from '@kb-chat/contracts';
import type {
  ResearchInput,
  ResearchRunnerPort,
} from '../ports/research-runner.js';
import type { SpendLedgerPort } from '../ports/spend-ledger.js';

export interface SubscriptionLedgerDeps {
  /** The owner's subscription CLI for this turn. */
  readonly inner: ResearchRunnerPort;
  /** The house ledger: a lent turn is recorded there, at US$ 0. */
  readonly ledger: SpendLedgerPort;
  readonly principal: string;
  readonly now?: () => Date;
}

/**
 * A lent subscription's turn (KBC-024, ADR 0019): relayed unchanged, and recorded in the house
 * ledger when it ends, at US$ 0 with `billing: subscription`, so the record shows who used it.
 */
export class SubscriptionLedgerRunner implements ResearchRunnerPort {
  readonly billing = 'subscription' as const;

  constructor(private readonly deps: SubscriptionLedgerDeps) {}

  get model(): string {
    return this.deps.inner.model;
  }

  configured(): boolean {
    return this.deps.inner.configured();
  }

  async *run(input: ResearchInput): AsyncIterable<ResearchEvent> {
    for await (const event of this.deps.inner.run(input)) {
      if (event.type === 'done')
        await this.deps.ledger.append({
          ts: (this.deps.now?.() ?? new Date()).toISOString(),
          principal: this.deps.principal,
          model: event.model,
          inputTokens: 0,
          outputTokens: 0,
          usd: 0,
          interrupted: event.interrupted,
          billing: 'subscription',
        });
      yield event;
    }
  }
}
