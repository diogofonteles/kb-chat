import { afterEach, describe, expect, it } from 'vitest';
import { QmdMcpAdapter, type QmdClient } from './qmd-mcp-adapter.js';

const query = (q: string) =>
  ({ collection: 'hermetismo', q, mode: 'all', limit: 5 }) as const;

const tick = (ms = 0) => new Promise((done) => setTimeout(done, ms));

/**
 * Fake `qmd mcp` children, in process: each `open` is a spawn, each `close` a kill, and a
 * `slow` search waits until `finishSlow` lets every one of them answer.
 */
class FakeQmd {
  readonly spawned: FakeChild[] = [];
  /** Spawns waiting for `admit` (an open still in flight). */
  private readonly held: (() => void)[] = [];
  holdOpens = false;
  /** How many of the next spawns fail (the new index does not open). */
  failOpens = 0;
  private slow: (() => void)[] = [];

  readonly open = async (): Promise<QmdClient> => {
    if (this.holdOpens) await new Promise<void>((go) => this.held.push(go));
    if (this.failOpens > 0) {
      this.failOpens -= 1;
      throw new Error('qmd mcp did not start');
    }
    const child = new FakeChild(this.spawned.length + 1, this);
    this.spawned.push(child);
    return child;
  };

  admit(): void {
    for (const go of this.held.splice(0)) go();
  }

  alive(): number[] {
    return this.spawned.filter((one) => !one.killed).map((one) => one.pid);
  }

  waitSlow(): Promise<void> {
    return new Promise((done) => this.slow.push(done));
  }

  finishSlow(): void {
    for (const done of this.slow.splice(0)) done();
  }
}

class FakeChild implements QmdClient {
  killed = false;
  onclose?: (() => void) | undefined;

  constructor(
    readonly pid: number,
    private readonly fake: FakeQmd,
  ) {}

  async callTool(params: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown> {
    if (this.killed) throw new Error('process gone');
    const [search] = params.arguments['searches'] as { query: string }[];
    if (search?.query === 'slow') await this.fake.waitSlow();
    if (this.killed) throw new Error('interrupted');
    return {
      structuredContent: {
        results: [{ file: 'x/pid.md', score: 1, snippet: `${this.pid}` }],
      },
    };
  }

  async close(): Promise<void> {
    this.killed = true;
  }

  /** The process dies on its own. */
  crash(): void {
    this.killed = true;
    this.onclose?.();
  }
}

let adapter: QmdMcpAdapter | undefined;
afterEach(async () => {
  await adapter?.close();
  adapter = undefined;
});

const pidOf = async (one: QmdMcpAdapter) =>
  Number((await one.search(query('pid')))[0]?.snippet);

describe('QmdMcpAdapter swaps (KBC-100 review 2, NFR-2)', () => {
  it('a reload while a reconnect is scheduled leaves one process alive', async () => {
    const fake = new FakeQmd();
    adapter = new QmdMcpAdapter({
      command: 'qmd',
      openClient: fake.open,
      backoffMs: [30],
      drainMs: 1_000,
    });
    await adapter.start();
    fake.spawned[0]?.crash();
    expect(adapter.status()).toBe('down');

    await adapter.reload();
    await tick(80); // past the reconnect's backoff

    expect(fake.spawned).toHaveLength(2);
    expect(fake.alive()).toEqual([2]);
    expect(await pidOf(adapter)).toBe(2);
  });

  it('a reload that fails while the process is down schedules the reconnect again (review 3)', async () => {
    const fake = new FakeQmd();
    adapter = new QmdMcpAdapter({
      command: 'qmd',
      openClient: fake.open,
      backoffMs: [30],
      drainMs: 1_000,
    });
    await adapter.start();
    fake.spawned[0]?.crash();
    fake.failOpens = 1;

    await expect(adapter.reload()).rejects.toThrow('qmd mcp did not start');
    await tick(100); // past the reconnect's backoff

    expect(fake.alive()).toEqual([2]);
    expect(adapter.status()).toBe('ok');
    expect(await pidOf(adapter)).toBe(2);
  });

  it('a reload that fails while the process serves keeps it and schedules nothing', async () => {
    const fake = new FakeQmd();
    adapter = new QmdMcpAdapter({
      command: 'qmd',
      openClient: fake.open,
      backoffMs: [30],
      drainMs: 1_000,
    });
    await adapter.start();
    fake.failOpens = 1;

    await expect(adapter.reload()).rejects.toThrow('qmd mcp did not start');
    await tick(100);

    expect(fake.spawned).toHaveLength(1);
    expect(fake.alive()).toEqual([1]);
    expect(await pidOf(adapter)).toBe(1);
  });

  it('a reload that crosses a reconnect in flight closes the one that lost', async () => {
    const fake = new FakeQmd();
    adapter = new QmdMcpAdapter({
      command: 'qmd',
      openClient: fake.open,
      backoffMs: [10],
      drainMs: 1_000,
    });
    await adapter.start();
    fake.holdOpens = true;
    fake.spawned[0]?.crash();
    await tick(40); // the reconnect is opening, held
    fake.holdOpens = false;

    await adapter.reload(); // opens process 2 and takes the searches
    fake.admit(); // the reconnect's process 3 arrives after it
    await tick(80);

    expect(fake.spawned).toHaveLength(3);
    expect(fake.alive()).toHaveLength(1);
    expect(fake.alive()).toEqual([await pidOf(adapter)]);
  });

  it('NFR-2: ten swaps with long searches running interrupt none and never leave search down', async () => {
    const fake = new FakeQmd();
    adapter = new QmdMcpAdapter({
      command: 'qmd',
      openClient: fake.open,
      drainMs: 60_000,
    });
    await adapter.start();
    const running: Promise<unknown>[] = [];
    for (let swap = 0; swap < 10; swap += 1) {
      running.push(adapter.search(query('slow')));
      const reloading = adapter.reload();
      expect(adapter.status()).toBe('ok');
      await reloading;
      expect(adapter.status()).toBe('ok');
    }
    // Each swapped-out process waits for its search before it closes.
    expect(fake.alive()).toHaveLength(11);

    fake.finishSlow();
    const results = await Promise.allSettled(running);
    expect(results.filter((one) => one.status === 'rejected')).toEqual([]);
    await expect.poll(() => fake.alive(), { timeout: 2_000 }).toEqual([11]);
  });
});
