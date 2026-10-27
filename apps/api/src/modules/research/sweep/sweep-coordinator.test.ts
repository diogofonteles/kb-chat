import {
  sweepPlanSchema,
  type SweepPlan,
  type SweepProgress,
} from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import {
  MemoryVault,
  memoryDoc,
  memoryTools,
} from '../../../../test/memory-research.js';
import { AppError } from '../../../app-error.js';
import {
  LlmCapacityError,
  LlmKeyRejectedError,
} from '../../../ports/llm-errors.js';
import type { ResearchTools } from '../tools.js';
import { SourceBook } from '../source-book.js';
import {
  SweepCoordinator,
  type BatchEngine,
  type SweepClock,
  type SweepRequest,
} from './sweep-coordinator.js';

const DOCS = 6;

function corpus(): Record<string, string> {
  const docs: Record<string, string> = {};
  for (let i = 1; i <= DOCS; i += 1)
    docs[`raw/t${i}.md`] = memoryDoc({
      title: `Tema ${i}`,
      body: `Tema ${i}: leiam o livro ${i}. ${'texto '.repeat(150)}`,
      authorGroup: 'mestre-laercio',
    });
  docs['raw/outro.md'] = memoryDoc({
    title: 'Outro',
    body: 'livro de outro autor',
    authorGroup: 'outros-autores',
  });
  return docs;
}

const PLAN: SweepPlan = sweepPlanSchema.parse({
  target: { authorship: 'mestre-laercio' },
  extract: 'livros citados',
});

/** A model that cites the first document of each batch; scripted failures by call. */
class FakeEngine implements BatchEngine {
  readonly calls: string[] = [];
  active = 0;
  maxActive = 0;

  constructor(
    readonly options: {
      readonly free?: boolean;
      readonly parallel?: number;
      readonly fail?: (call: number) => Error | null;
      readonly reply?: (user: string) => string;
    } = {},
  ) {}

  get free(): boolean {
    return this.options.free ?? false;
  }

  get parallel(): number {
    return this.options.parallel ?? 3;
  }

  async extract({ user }: { system: string; user: string }): Promise<string> {
    this.calls.push(user);
    const failure = this.options.fail?.(this.calls.length);
    if (failure) throw failure;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    this.active -= 1;
    if (this.options.reply) return this.options.reply(user);
    const title = /\[D1\] (Tema \d+)/.exec(user)?.[1] ?? '?';
    return `- [D1] Livro citado em ${title} — “leiam o livro”\n- [D9] inventado`;
  }
}

/** A clock whose sleeps pass at once but are recorded; time moves only by sleeping. */
class FakeClock implements SweepClock {
  time = 0;
  readonly sleeps: number[] = [];

  now(): number {
    return this.time;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.time += ms;
  }
}

let tools: ResearchTools;

async function sweep(
  engine: BatchEngine,
  options: Partial<SweepRequest> & { after?: string; clock?: SweepClock } = {},
) {
  tools ??= await memoryTools(new MemoryVault(corpus()));
  const layout = await tools.sweeps.layout('hermetismo', {
    plan: PLAN,
    batchChars: 1_000,
    after: options.after,
  });
  if (!layout) throw new Error('no layout');
  const events: SweepProgress[] = [];
  const coordinator = new SweepCoordinator({
    engine,
    sweeps: tools.sweeps,
    emit: (progress) => events.push(progress),
    clock: options.clock ?? new FakeClock(),
  });
  const outcome = await coordinator.run({
    topic: 'hermetismo',
    topicTitle: 'Hermetismo',
    question: 'Quais livros o Mestre cita?',
    layout,
    book: new SourceBook(),
    signal: new AbortController().signal,
    deadline: null,
    maxRequests: 100,
    requestsBefore: 2,
    findingsChars: 100_000,
    ...options,
  });
  return { outcome, events, layout };
}

describe('SweepCoordinator (KBC-030)', () => {
  it('sweeps every batch, estimates first, then reports progress and the true coverage', async () => {
    const engine = new FakeEngine();
    const { outcome, events, layout } = await sweep(engine);
    expect(layout.batches.length).toBe(DOCS);
    expect(engine.calls).toHaveLength(DOCS);
    expect(events[0]).toMatchObject({
      status: 'planned',
      documents: DOCS,
      batches: DOCS,
      requests: 2 + DOCS + 1,
    });
    expect(events.at(-1)).toMatchObject({
      status: 'running',
      batchesDone: DOCS,
      documentsDone: DOCS,
    });
    expect(outcome.coverage).toMatchObject({
      documents: DOCS,
      scanned: DOCS,
      read: DOCS,
      withHits: null,
      missing: 0,
      batches: DOCS,
    });
    expect(outcome.coverage.reason).toBeUndefined();
    expect(outcome.cursor).toBeNull();
    expect(outcome.findings.lines()).toHaveLength(DOCS);
    expect(engine.maxActive).toBeLessThanOrEqual(3);
  });

  it('stops at the request budget with a cursor, and a continuation sweeps only the rest', async () => {
    const first = await sweep(new FakeEngine({ parallel: 1 }), {
      maxRequests: 2,
    });
    expect(first.outcome.coverage).toMatchObject({
      read: 2,
      missing: DOCS - 2,
      reason: 'requests',
    });
    expect(first.outcome.cursor?.after).toBe('raw/t2.md');
    const engine = new FakeEngine();
    const rest = await sweep(engine, {
      after: first.outcome.cursor?.after,
      previous: first.outcome.cursor?.totals,
    });
    expect(engine.calls).toHaveLength(DOCS - 2);
    expect(engine.calls.join()).not.toContain('Tema 1');
    expect(rest.outcome.coverage).toMatchObject({
      documents: DOCS,
      read: DOCS,
      missing: 0,
      batches: DOCS,
    });
  });

  it('waits 15, 30 and 60 s on capacity errors, then stops with what it has', async () => {
    const clock = new FakeClock();
    const engine = new FakeEngine({
      parallel: 1,
      fail: (call) => (call >= 3 ? new LlmCapacityError('x', '429') : null),
    });
    const { outcome } = await sweep(engine, { clock });
    expect(clock.sleeps).toEqual([15_000, 30_000, 60_000]);
    expect(outcome.coverage).toMatchObject({ read: 2, reason: 'capacity' });
    expect(outcome.cursor?.after).toBe('raw/t2.md');
  });

  it('goes on after one refused request', async () => {
    const engine = new FakeEngine({
      parallel: 1,
      fail: (call) => (call === 2 ? new LlmCapacityError('x', '429') : null),
    });
    const { outcome } = await sweep(engine);
    expect(outcome.coverage.missing).toBe(0);
  });

  it('stops at the daily spend cap', async () => {
    const engine = new FakeEngine({
      parallel: 1,
      fail: (call) =>
        call === 4 ? new AppError('DAILY_CAP_REACHED', 'cap') : null,
    });
    const { outcome } = await sweep(engine);
    expect(outcome.coverage).toMatchObject({ read: 3, reason: 'spend' });
  });

  it('stops at the wall-clock ceiling', async () => {
    const clock = new FakeClock();
    const { outcome } = await sweep(
      new FakeEngine({ free: true, parallel: 1 }),
      {
        clock,
        deadline: 5_000,
      },
    );
    expect(outcome.coverage.reason).toBe('time');
    expect(outcome.coverage.missing).toBeGreaterThan(0);
  });

  it('paces a free model at one request start every 3.2 s', async () => {
    const clock = new FakeClock();
    await sweep(new FakeEngine({ free: true, parallel: 1 }), { clock });
    expect(clock.sleeps).toEqual(Array(DOCS - 1).fill(3_200));
    expect(clock.time).toBeGreaterThanOrEqual((DOCS - 1) * 3_200);
  });

  it('starts no request after the reader stops', async () => {
    const abort = new AbortController();
    const engine = new FakeEngine({
      parallel: 1,
      fail: (call) => {
        if (call === 2) abort.abort();
        return null;
      },
    });
    const { outcome } = await sweep(engine, { signal: abort.signal });
    expect(engine.calls).toHaveLength(2);
    expect(outcome.coverage.reason).toBe('stopped');
  });

  it('fails the turn on a refused key', async () => {
    const engine = new FakeEngine({
      fail: () => new LlmKeyRejectedError('x', 401),
    });
    await expect(sweep(engine)).rejects.toBeInstanceOf(LlmKeyRejectedError);
  });

  it('condenses findings that do not fit the answer call', async () => {
    const engine = new FakeEngine({
      parallel: 1,
      reply: (user) =>
        user.startsWith('Achados')
          ? '- [1] Livro único'
          : `- [D1] ${'achado longo '.repeat(20)}${user.length}`,
    });
    const { outcome } = await sweep(engine, { findingsChars: 400 });
    expect(engine.calls.some((c) => c.startsWith('Achados'))).toBe(true);
    expect(outcome.findings.lines().join('\n').length).toBeLessThanOrEqual(400);
  });

  it('carries its findings in the cursor and each batch’s new ones in the progress (QA F-1)', async () => {
    const { outcome, events } = await sweep(new FakeEngine({ parallel: 1 }), {
      maxRequests: 2,
    });
    expect(outcome.cursor?.findings).toEqual([
      { id: 'raw/t1.md', text: 'Livro citado em Tema 1 — “leiam o livro”' },
      { id: 'raw/t2.md', text: 'Livro citado em Tema 2 — “leiam o livro”' },
    ]);
    const running = events.filter((e) => e.status === 'running');
    expect(running.map((e) => e.found?.length)).toEqual([1, 1]);
    expect(running[0]?.cursor?.findings).toEqual([]);
  });

  it('answers a continuation with what the earlier turns found too (QA F-1)', async () => {
    const first = await sweep(new FakeEngine({ parallel: 1 }), {
      maxRequests: 2,
    });
    const rest = await sweep(new FakeEngine(), {
      after: first.outcome.cursor?.after,
      previous: first.outcome.cursor?.totals,
      carried: first.outcome.cursor?.findings,
    });
    const lines = rest.outcome.findings.lines().join('\n');
    expect(lines).toContain('Tema 1');
    expect(lines).toContain('Tema 6');
    expect(rest.outcome.findings.size).toBe(DOCS);
  });

  it('drops carried findings of documents outside the set', async () => {
    const { outcome } = await sweep(new FakeEngine(), {
      carried: [{ id: 'raw/forjado.md', text: 'inventado' }],
    });
    expect(outcome.findings.lines().join()).not.toContain('inventado');
  });
});
