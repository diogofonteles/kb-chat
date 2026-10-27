import type { FreeUsage, ResearchEvent } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import type {
  ResearchInput,
  ResearchRunnerPort,
} from '../ports/research-runner.js';
import { HouseQuota } from '../modules/house-ai/index.js';
import { HouseResearchRunner } from './house-runner.js';

/** A runner that only records the input it was given. */
class RecordingRunner implements ResearchRunnerPort {
  readonly model = 'fake/large:free';
  readonly billing = 'per-token' as const;
  seen: ResearchInput | null = null;

  configured(): boolean {
    return true;
  }

  async *run(input: ResearchInput): AsyncIterable<ResearchEvent> {
    this.seen = input;
    yield {
      type: 'done',
      usd: 0,
      billing: 'per-token',
      model: this.model,
      interrupted: false,
      steps: 0,
    };
  }
}

const quota = new HouseQuota({
  ledger: { append: async () => undefined, unitsSince: async () => 0 },
});

function house(inner: RecordingRunner, usage: FreeUsage | null) {
  return new HouseResearchRunner({
    preview: inner,
    quota,
    principal: 'ana',
    dailyLimit: 10,
    capacity: async () => usage,
    startTurn: () => ({ inner, paidActive: false, finish: () => undefined }),
  });
}

const input = (profile: ResearchInput['profile']): ResearchInput => ({
  topic: 'hermetismo',
  question: 'q',
  history: [],
  profile,
  signal: new AbortController().signal,
});

async function drain(events: AsyncIterable<ResearchEvent>) {
  const out: ResearchEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('HouseResearchRunner and the exhaustive sweep (KBC-030)', () => {
  it('lends the sweep only the free requests the house has left today', async () => {
    const inner = new RecordingRunner();
    await drain(
      house(inner, { used: 880, limit: 1000, remaining: 120 }).run(
        input('exhaustive'),
      ),
    );
    expect(inner.seen?.requestBudget).toBe(120);
  });

  it('never lends one sweep more than a quarter of the house’s day, shared by everyone', async () => {
    const inner = new RecordingRunner();
    await drain(
      house(inner, { used: 0, limit: 1000, remaining: 1000 }).run(
        input('exhaustive'),
      ),
    );
    expect(inner.seen?.requestBudget).toBe(250);
  });

  it('sets no budget when the capacity is unknown', async () => {
    const inner = new RecordingRunner();
    await drain(house(inner, null).run(input('exhaustive')));
    expect(inner.seen?.requestBudget).toBeUndefined();
  });
});
