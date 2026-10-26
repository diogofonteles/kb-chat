import type { SearchOrigin, UsageEvent, UsageRecord } from '@kb-chat/contracts';
import type { SpendEntry } from '../src/ports/spend-ledger.js';
import { toCatalogEntry } from '../src/modules/catalog/catalog-entry.js';

/** A usage record as the API writes it. */
export const aRecord = (
  ts: string,
  sessionId: string,
  event: UsageEvent,
): UsageRecord => ({ ...event, ts, sessionId, principal: 'owner' });

export const aSearch = (
  ts: string,
  sessionId: string,
  {
    origin = 'typed',
    filterCount = 0,
  }: { origin?: SearchOrigin; filterCount?: number } = {},
): UsageRecord =>
  aRecord(ts, sessionId, {
    type: 'search',
    origin,
    question: 'q',
    mode: 'all',
    filterCount,
    total: 1,
    tookMs: 10,
  });

export const aSpend = (ts: string, usd: number): SpendEntry => ({
  ts,
  usd,
  principal: 'owner',
  model: 'm',
  inputTokens: 1,
  outputTokens: 1,
  interrupted: false,
});

/** A catalog entry with only the subjects set, built like the real catalog builds it. */
export const anEntryWith = (concepts: string[]) =>
  toCatalogEntry('raw/doc.md', { concepts });
