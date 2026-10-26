import type { ResearchProfile } from '@kb-chat/contracts';

/** Researches counted against a person's house quota (KBC-022); a refund is negative. */
export interface HouseUsageEntry {
  readonly ts: string;
  readonly principal: string;
  readonly units: number;
  readonly profile: ResearchProfile;
}

/** Append-only record of house-plan researches, per principal (ADR 0016). */
export interface HouseUsagePort {
  append(entry: HouseUsageEntry): Promise<void>;
  /** Units the principal used since an instant (refunds subtracted). */
  unitsSince(principal: string, since: Date): Promise<number>;
}
