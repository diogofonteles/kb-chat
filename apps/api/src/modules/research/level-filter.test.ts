import { beforeAll, describe, expect, it } from 'vitest';
import {
  MemoryVault,
  memoryDoc,
  memoryTools,
} from '../../../test/memory-research.js';
import {
  OPEN_VIEW,
  scaledView,
  type LevelView,
  type StoredLevel,
} from '../access-levels/index.js';
import { SourceBook } from './source-book.js';
import type { ResearchTools } from './tools.js';

/*
 * KBC-104 NFR-1: the person's view adds at most 10 ms (p95) to a tool call over a collection
 * of 10,000 documents, half of them above the person's level. No model: the tools alone.
 */

const COUNT = 10_000;
const RUNS = 30;

const level = (id: string): StoredLevel => ({
  id,
  code: id.toUpperCase(),
  description: '',
  createdBy: 'owner@example.com',
  createdAt: '2026-11-10T00:00:00.000Z',
});

const ids = Array.from({ length: COUNT }, (_, n) => `raw/d-${n}.md`);

const placements = Object.fromEntries(
  ids.map((id, n) => [
    id,
    {
      level: n % 2 === 0 ? 'qs' : 'ci',
      setBy: 'owner@example.com',
      setAt: '2026-11-10T00:00:00.000Z',
    },
  ]),
);

/** Half the documents at QS, half at CI; the viewer at QS. */
const halfHidden: LevelView = scaledView({
  scale: [level('qs'), level('ci')],
  rank: 0,
  placementsOf: () => placements,
  memo: (_catalog, compute) => compute(),
});

async function bigTools(): Promise<ResearchTools> {
  const docs = Object.fromEntries(
    ids.map((id, n) => [
      id,
      memoryDoc({
        title: `Documento ${n}`,
        body: `Um texto sobre a lua número ${n}.`,
        sourcePath: `Temas/${n % 50}/d-${n}.pdf`,
      }),
    ]),
  );
  const tools = await memoryTools(new MemoryVault(docs));
  await tools.warm('hermetismo');
  return tools;
}

const p95 = (times: number[]): number => {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Infinity;
};

async function timed(
  tools: ResearchTools,
  view: LevelView,
  call: { name: string; arguments: object },
): Promise<{ p95: number; output: string }> {
  const times: number[] = [];
  let output = '';
  for (let run = 0; run < RUNS; run += 1) {
    const startedAt = performance.now();
    output = await tools
      .prepare(
        { id: 'c', name: call.name, arguments: JSON.stringify(call.arguments) },
        { topic: 'hermetismo', book: new SourceBook(), view },
      )
      .run();
    times.push(performance.now() - startedAt);
  }
  return { p95: p95(times), output };
}

describe('The person view costs little per tool call (KBC-104 NFR-1)', () => {
  let tools: ResearchTools;
  beforeAll(async () => {
    tools = await bigTools();
  }, 120_000);

  it.each([
    { name: 'list_sources', arguments: {} },
    {
      name: 'find_text',
      arguments: { phrase: 'lua', output_mode: 'count' },
    },
    {
      name: 'find_text',
      arguments: { source: 'Temas', output_mode: 'files' },
    },
  ])(
    '$name adds p95 ≤ 10 ms over 10,000 documents with half of them hidden',
    async (call) => {
      const open = await timed(tools, OPEN_VIEW, call);
      const scaled = await timed(tools, halfHidden, call);
      // The view really filtered: the visible half only.
      expect(scaled.output).not.toEqual(open.output);
      const added = scaled.p95 - open.p95;
      // Evidence for work/KBC-104 (KBC_NFR_REPORT=1), never in a normal run.
      if (process.env['KBC_NFR_REPORT'])
        process.stdout.write(
          `NFR-1 ${call.name} ${JSON.stringify(call.arguments)}: p95 open ${open.p95.toFixed(2)} ms, half hidden ${scaled.p95.toFixed(2)} ms\n`,
        );
      expect(
        added,
        `p95 open ${open.p95.toFixed(2)} ms, half hidden ${scaled.p95.toFixed(2)} ms`,
      ).toBeLessThanOrEqual(10);
    },
    60_000,
  );
});
