export interface SpendEntry {
  readonly ts: string;
  readonly principal: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usd: number;
  readonly interrupted: boolean;
  /** A lent subscription's turn: US$ 0, kept for the record (KBC-024); absent per token. */
  readonly billing?: 'subscription';
}

/** Append-only record of AI spend (ADR 0004, keyed by principal per ADR 0005). */
export interface SpendLedgerPort {
  append(entry: SpendEntry): Promise<void>;
  /** Spend of the principal since local midnight. */
  spentToday(principal: string, now?: Date): Promise<number>;
  /** Spend of the principal since an instant (the house's monthly cap, KBC-022). */
  spentSince(principal: string, since: Date): Promise<number>;
}
