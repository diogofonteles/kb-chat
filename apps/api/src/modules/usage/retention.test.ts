import { describe, expect, it, vi } from 'vitest';
import { MemoryUsageLog } from '../../adapters/memory-usage-log.js';
import { aRecord } from '../../../test/usage-factories.js';
import { applyUsageRetention } from './retention.js';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString();

describe('applyUsageRetention at startup (KBC-006 FR-5, AC-5)', () => {
  it('removes events older than 90 days and logs how many', async () => {
    const log = new MemoryUsageLog();
    await log.append(aRecord(daysAgo(91), 's', { type: 'ai_cancel' }));
    await log.append(aRecord(daysAgo(89), 's', { type: 'ai_cancel' }));
    const logger = { info: vi.fn(), warn: vi.fn() };
    expect(await applyUsageRetention(log, logger, NOW)).toBe(1);
    expect(log.records.map((r) => r.ts)).toEqual([daysAgo(89)]);
    expect(logger.info).toHaveBeenCalledWith(
      { removed: 1 },
      expect.any(String),
    );
  });

  it('only warns when the log cannot be pruned', async () => {
    const log = new MemoryUsageLog();
    log.prune = () => Promise.reject(new Error('EACCES'));
    const logger = { info: vi.fn(), warn: vi.fn() };
    expect(await applyUsageRetention(log, logger, NOW)).toBe(0);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
