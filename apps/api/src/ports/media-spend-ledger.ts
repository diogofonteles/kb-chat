/** What a paid media run spends on (ADR 0022 §7). */
export type MediaSpendKind = 'track-proposal' | 'subject-proposal';

/** How a reservation ended: all of it counted, or the unspent part given back. */
export type MediaSpendOutcome = 'settled' | 'refunded';

/**
 * The media monthly spend ledger (ADR 0022 §7, KBC-067 BR-3): a run reserves its estimate
 * before calling the provider; when it ends, only what it really spent stays counted.
 */
export interface MediaSpendLedgerPort {
  /**
   * Reserves `usd` when what was spent and reserved since `since`, plus `usd`, stays within
   * `capUsd`; checked and written in one transaction. False when it would cross the cap.
   */
  reserve(input: {
    readonly id: string;
    readonly kind: MediaSpendKind;
    readonly mediaId: string;
    readonly principal: string;
    readonly usd: number;
    readonly capUsd: number;
    readonly since: Date;
    readonly now: Date;
  }): boolean;
  /** Spent plus still reserved since `since` (the month's balance for masters, FR-4). */
  usedSince(since: Date): number;
  /**
   * At start, when no run is in flight: every reservation still open is an orphan (a crash
   * between reserving and closing); each is refunded, keeping what it recorded as spent.
   */
  refundOpen(now: Date): number;
  /** Ends a reservation with what was really spent. */
  close(input: {
    readonly id: string;
    readonly spentUsd: number;
    readonly outcome: MediaSpendOutcome;
    readonly now: Date;
  }): void;
}
