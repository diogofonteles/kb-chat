export interface SpendEntry {
  readonly ts: string;
  readonly principal: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usd: number;
  readonly interrupted: boolean;
}

/** Append-only record of AI spend (ADR 0004, keyed by principal per ADR 0005). */
export interface SpendLedgerPort {
  append(entry: SpendEntry): Promise<void>;
  /** Spend of the principal since local midnight. */
  spentToday(principal: string, now?: Date): Promise<number>;
}
