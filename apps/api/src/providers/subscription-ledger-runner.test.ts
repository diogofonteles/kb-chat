import type { ResearchEvent } from '@kb-chat/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ResearchRunnerPort } from '../ports/research-runner.js';
import type { SpendEntry, SpendLedgerPort } from '../ports/spend-ledger.js';
import { SubscriptionLedgerRunner } from './subscription-ledger-runner.js';
import { OPEN_VIEW } from '../modules/access-levels/index.js';

const DONE: ResearchEvent = {
  type: 'done',
  usd: 0,
  billing: 'subscription',
  model: 'sonnet',
  interrupted: false,
  steps: 2,
};

function innerRunner(events: ResearchEvent[]): ResearchRunnerPort {
  return {
    model: 'sonnet',
    billing: 'subscription',
    configured: () => true,
    async *run() {
      yield* events;
    },
  };
}

function recordingLedger() {
  const entries: SpendEntry[] = [];
  const ledger: SpendLedgerPort = {
    append: async (entry) => {
      entries.push(entry);
    },
    spentToday: async () => 0,
    spentSince: async () => 0,
  };
  return { entries, ledger };
}

const input = {
  topic: 'hermetismo',
  view: OPEN_VIEW,
  question: 'q',
  history: [],
  profile: 'fast' as const,
  signal: new AbortController().signal,
};

describe('SubscriptionLedgerRunner (KBC-024 AC-2)', () => {
  it('relays the turn and records it at US$ 0 for the person who used it', async () => {
    const { entries, ledger } = recordingLedger();
    const token: ResearchEvent = { type: 'token', text: 'ok', segment: 0 };
    const runner = new SubscriptionLedgerRunner({
      inner: innerRunner([token, DONE]),
      ledger,
      principal: 'sub-ana',
      now: () => new Date('2026-10-26T12:00:00.000Z'),
    });
    const seen: ResearchEvent[] = [];
    for await (const event of runner.run(input)) seen.push(event);
    expect(seen).toEqual([token, DONE]);
    expect(entries).toEqual([
      {
        ts: '2026-10-26T12:00:00.000Z',
        principal: 'sub-ana',
        model: 'sonnet',
        inputTokens: 0,
        outputTokens: 0,
        usd: 0,
        interrupted: false,
        billing: 'subscription',
      },
    ]);
    expect(runner.model).toBe('sonnet');
    expect(runner.configured()).toBe(true);
  });

  it('records nothing for a turn that failed before it was done', async () => {
    const { entries, ledger } = recordingLedger();
    const failed = vi.fn();
    const runner = new SubscriptionLedgerRunner({
      inner: innerRunner([{ type: 'error', code: 'CLI_LOGIN_REQUIRED' }]),
      ledger,
      principal: 'sub-ana',
      failed,
    });
    for await (const event of runner.run(input))
      expect(event.type).toBe('error');
    expect(entries).toEqual([]);
    expect(failed).toHaveBeenCalledWith('CLI_LOGIN_REQUIRED');
  });
});
