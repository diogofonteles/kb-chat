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

/** An inner runner that plays a scripted turn. */
class ScriptedRunner implements ResearchRunnerPort {
  readonly model = 'fake/large:free';
  readonly billing = 'per-token' as const;
  constructor(private readonly events: readonly ResearchEvent[]) {}
  configured(): boolean {
    return true;
  }
  async *run(): AsyncIterable<ResearchEvent> {
    yield* this.events;
  }
}

function withLedger() {
  const entries: { units: number }[] = [];
  const ledgerQuota = new HouseQuota({
    ledger: {
      append: async (entry) => {
        entries.push(entry);
      },
      unitsSince: async () => entries.reduce((sum, e) => sum + e.units, 0),
    },
  });
  const runner = (inner: ResearchRunnerPort) =>
    new HouseResearchRunner({
      preview: inner,
      quota: ledgerQuota,
      principal: 'mariano',
      dailyLimit: 5,
      capacity: async () => ({ used: 0, limit: 1000, remaining: 1000 }),
      startTurn: () => ({ inner, paidActive: false, finish: () => undefined }),
    });
  const used = () => entries.reduce((sum, e) => sum + e.units, 0);
  return { runner, used };
}

describe('HouseResearchRunner gives the day back when no answer came (KBC-061)', () => {
  it('refunds a sweep that failed after working, with no answer', async () => {
    const { runner, used } = withLedger();
    await drain(
      runner(
        new ScriptedRunner([
          { type: 'step', step: { kind: 'sweep', text: 'lote 1' } },
          { type: 'sources', sources: [] },
          { type: 'error', code: 'PROVIDER_UNAVAILABLE' },
        ]),
      ).run(input('exhaustive')),
    );
    expect(used()).toBe(0);
  });

  it('keeps the units once part of the answer was written', async () => {
    const { runner, used } = withLedger();
    await drain(
      runner(
        new ScriptedRunner([
          { type: 'token', text: 'O mentalismo', segment: 0 },
          { type: 'error', code: 'PROVIDER_UNAVAILABLE' },
        ]),
      ).run(input('fast')),
    );
    expect(used()).toBe(1);
  });

  it('lets the next question through after a failed sweep (Mariano’s report)', async () => {
    const { runner } = withLedger();
    const failed = new ScriptedRunner([
      { type: 'step', step: { kind: 'sweep', text: 'lote 1' } },
      { type: 'error', code: 'PROVIDER_UNAVAILABLE' },
    ]);
    await drain(runner(failed).run(input('exhaustive')));
    const next = await drain(runner(new RecordingRunner()).run(input('fast')));
    expect(next.at(-1)?.type).toBe('done');
  });
});
