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
import { SweepPacer } from './sweep-pacing.js';
import { coveredMark } from './sweep-cursor.js';
import {
  SweepCoordinator,
  type BatchEngine,
  type SweepClock,
  type SweepDeps,
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
  readonly starts: number[] = [];
  active = 0;
  maxActive = 0;

  constructor(
    readonly options: {
      readonly free?: boolean;
      readonly parallel?: number;
      readonly fail?: (call: number) => Error | null;
      readonly reply?: (user: string) => string;
      /** Records when each call started, on this clock. */
      readonly clock?: SweepClock;
      readonly estimateUsd?: (chars: number, calls: number) => Promise<number>;
    } = {},
  ) {}

  get free(): boolean {
    return this.options.free ?? false;
  }

  get parallel(): number {
    return this.options.parallel ?? 3;
  }

  get estimateUsd() {
    return this.options.estimateUsd;
  }

  async extract({ user }: { system: string; user: string }): Promise<string> {
    this.calls.push(user);
    this.starts.push(this.options.clock?.now() ?? 0);
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
  options: Partial<SweepRequest> & {
    after?: string;
    covered?: string;
    clock?: SweepClock;
    plan?: SweepPlan;
    sweeps?: SweepDeps['sweeps'];
  } = {},
) {
  tools ??= await memoryTools(new MemoryVault(corpus()));
  const layout = await tools.sweeps.layout('hermetismo', {
    plan: options.plan ?? PLAN,
    batchChars: 1_000,
    after: options.after,
    covered: options.covered,
  });
  if (!layout) throw new Error('no layout');
  const events: SweepProgress[] = [];
  const coordinator = new SweepCoordinator({
    engine,
    sweeps: options.sweeps ?? tools.sweeps,
    emit: (progress) => events.push(progress),
    clock: options.clock ?? new FakeClock(),
    // Each test paces on its own: the process's pacer is shared.
    pacer: new SweepPacer(),
  });
  const outcome = await coordinator.run({
    topic: 'hermetismo',
    topicTitle: 'Hermetismo',
    mainAuthor: { name: 'Mestre Laércio' },
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

  it('marks in its cursor every document covered, the earlier turns’ too (code review 2 of KBC-101)', async () => {
    const first = await sweep(new FakeEngine({ parallel: 1 }), {
      maxRequests: 2,
    });
    expect(first.outcome.cursor?.covered).toBe(
      coveredMark(['raw/t1.md', 'raw/t2.md']),
    );
    const rest = await sweep(new FakeEngine(), {
      after: first.outcome.cursor?.after,
      covered: first.outcome.cursor?.covered,
      previous: first.outcome.cursor?.totals,
      carried: first.outcome.cursor?.findings,
    });
    expect(rest.outcome.resume.covered).toBe(
      coveredMark(Array.from({ length: DOCS }, (_, i) => `raw/t${i + 1}.md`)),
    );
  });

  it('reads no covered document again, so a carried finding is not found twice (code review 2 of KBC-101)', async () => {
    const engine = new FakeEngine();
    const { outcome } = await sweep(engine, {
      covered: coveredMark(['raw/t1.md', 'raw/t2.md', 'raw/t3.md']),
      carried: [{ id: 'raw/t3.md', text: 'Tema 3, escrito de outro jeito' }],
    });
    const lines = outcome.findings.lines().join('\n');
    expect(lines).toContain('escrito de outro jeito');
    expect(lines).not.toContain('Livro citado em Tema 3');
    expect(lines).toContain('Livro citado em Tema 4');
    expect(engine.calls.join('\n')).not.toContain('Tema 3:');
  });

  it('drops carried findings of documents outside the set', async () => {
    const { outcome } = await sweep(new FakeEngine(), {
      carried: [{ id: 'raw/forjado.md', text: 'inventado' }],
    });
    expect(outcome.findings.lines().join()).not.toContain('inventado');
  });

  it('never counts a batch whose call returned after the reader stopped (code review 2)', async () => {
    const abort = new AbortController();
    const engine = new FakeEngine({
      parallel: 1,
      reply: (user) => {
        abort.abort();
        return `- [D1] meio texto ${user.length}`;
      },
    });
    const { outcome } = await sweep(engine, { signal: abort.signal });
    expect(outcome.coverage.read).toBe(0);
    expect(outcome.coverage.reason).toBe('stopped');
    expect(outcome.findings.size).toBe(0);
  });

  it('keeps the free pace on retries after refusals (code review 3)', async () => {
    const clock = new FakeClock();
    const engine = new FakeEngine({
      free: true,
      parallel: 1,
      clock,
      fail: (call) => (call === 1 ? new LlmCapacityError('x', '429') : null),
    });
    await sweep(engine, { clock });
    const starts = [...engine.starts].sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i += 1)
      expect((starts[i] ?? 0) - (starts[i - 1] ?? 0)).toBeGreaterThanOrEqual(
        3_200,
      );
  });

  it('stops every other batch when the vault fails to read one (code review 4)', async () => {
    const engine = new FakeEngine({ parallel: 1 });
    tools ??= await memoryTools(new MemoryVault(corpus()));
    let reads = 0;
    const failing: SweepDeps['sweeps'] = {
      batchText: async (topic, batch) => {
        reads += 1;
        if (reads === 2) throw new Error('disk gone');
        return tools.sweeps.batchText(topic, batch);
      },
    };
    await expect(sweep(engine, { sweeps: failing })).rejects.toThrow(
      'disk gone',
    );
    expect(engine.calls).toHaveLength(1);
  });

  it('estimates the time on a free model and the cost on a paid one', async () => {
    const free = await sweep(new FakeEngine({ free: true }));
    expect(free.events[0]?.minutes).toBe(
      Math.ceil(((2 + DOCS + 1) * 3_200) / 60_000),
    );
    expect(free.events[0]?.usd).toBeUndefined();
    const paid = await sweep(
      new FakeEngine({
        estimateUsd: async (chars, calls) => chars * 1e-6 + calls,
      }),
    );
    expect(paid.events[0]?.usd).toBeGreaterThan(DOCS);
    expect(paid.events[0]?.minutes).toBeUndefined();
  });

  it('counts as missing only documents the AI still has to analyze (design review)', async () => {
    const plan = sweepPlanSchema.parse({
      ...PLAN,
      phrases: ['Tema 2', 'Tema 5'],
    });
    const { outcome } = await sweep(new FakeEngine({ parallel: 1 }), {
      plan,
      maxRequests: 1,
    });
    expect(outcome.coverage).toMatchObject({
      documents: DOCS,
      scanned: DOCS,
      withHits: 2,
      needed: 2,
      read: 1,
      missing: 1,
      reason: 'requests',
    });
  });

  it('fails the turn when a condensing call meets a refused key (code review round 2)', async () => {
    const engine = new FakeEngine({
      parallel: 1,
      reply: (user) => `- [D1] ${'achado longo '.repeat(20)}${user.length}`,
      fail: (call) => (call > DOCS ? new LlmKeyRejectedError('x', 401) : null),
    });
    await expect(sweep(engine, { findingsChars: 400 })).rejects.toBeInstanceOf(
      LlmKeyRejectedError,
    );
  });

  it('paces condensing calls on a free model like batches', async () => {
    const clock = new FakeClock();
    const engine = new FakeEngine({
      free: true,
      parallel: 1,
      clock,
      reply: (user) =>
        user.startsWith('Achados')
          ? '- [1] Livro único'
          : `- [D1] ${'achado longo '.repeat(20)}${user.length}`,
    });
    await sweep(engine, { clock, findingsChars: 400 });
    const starts = engine.starts;
    for (let i = 1; i < starts.length; i += 1)
      expect((starts[i] ?? 0) - (starts[i - 1] ?? 0)).toBeGreaterThanOrEqual(
        3_200,
      );
  });
});
