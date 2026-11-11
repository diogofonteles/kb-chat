import type {
  ResearchEvent,
  SweepCoverage,
  SweepCursor,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp, events, type Call } from '../test/ai-app-harness.js';
import {
  HIDDEN_TITLES,
  SIX,
  memberOf,
  placeDocuments,
  setPersonLevel,
  sixAtThreeLevels,
  startLevels,
} from '../test/levels-world.js';
import { StubLlmAdapter, type StubReply } from './adapters/stub-llm-adapter.js';
import { coveredMark } from './modules/research/sweep/sweep-cursor.js';

/*
 * KBC-104 BR-3, BR-4 (ADR 0036 §7, §8): the exhaustive sweep's set, batches and coverage are
 * the person's visible set; a cursor sent back by the page is re-checked against the view.
 */

afterEach(closeApp);

const PLAN = {
  target: {},
  phrases: [],
  extract: 'o que se diz da lua, com o trecho',
};

const planAll: StubReply = {
  toolCalls: [{ name: 'plan_sweep', arguments: PLAN }],
};

/** Every batch's text, as the model got it, and a stub that plans the whole collection. */
async function sweeping(script: readonly StubReply[] = [planAll]) {
  const batches: string[] = [];
  const llm = new StubLlmAdapter({
    script,
    finalText: 'Segundo a varredura, a lua aparece [1].',
    batchReply: (user) => {
      batches.push(user);
      return '';
    },
  });
  const world = await startLevels(SIX, { llm });
  const ana = await memberOf(world, 'ana@example.com');
  await sixAtThreeLevels(world);
  await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
  return { world, ana, llm, batches };
}

async function exhaustive(
  who: Call,
  extra: { sweep?: SweepCursor } = {},
): Promise<{ body: string; stream: ResearchEvent[] }> {
  const asked = await who('POST', '/api/v1/topics/hermetismo/research', {
    question: 'Liste tudo o que o acervo diz sobre a lua',
    profile: 'exhaustive',
    ...extra,
  });
  expect(asked.statusCode, asked.body).toBe(200);
  return { body: asked.body, stream: events(asked.body) };
}

function coverageOf(stream: readonly ResearchEvent[]): SweepCoverage {
  const done = stream.find((event) => event.type === 'done');
  if (done?.type !== 'done' || !done.coverage)
    throw new Error(`no coverage: ${JSON.stringify(stream.at(-1))}`);
  return done.coverage;
}

const plannedOf = (stream: readonly ResearchEvent[]) =>
  stream.flatMap((event) =>
    event.type === 'sweep' && event.sweep.status === 'planned'
      ? [event.sweep]
      : [],
  )[0];

const expectNoHidden = (text: string) => {
  for (const title of HIDDEN_TITLES) expect(text).not.toContain(title);
  expect(text).not.toContain('cdc-');
};

describe('The exhaustive sweep within the person level (KBC-104)', () => {
  it('AC-3: the coverage says 4 documents for Ana and 6 for the master; no batch shows Ana a CDC one', async () => {
    const { world, ana, batches } = await sweeping();
    const asAna = await exhaustive(ana.call);
    expect(coverageOf(asAna.stream)).toMatchObject({
      documents: 4,
      read: 4,
      missing: 0,
    });
    expect(plannedOf(asAna.stream)?.documents).toBe(4);
    expectNoHidden(batches.join('\n'));
    expectNoHidden(asAna.body);

    batches.length = 0;
    const asMaster = await exhaustive(world.owner);
    expect(coverageOf(asMaster.stream)).toMatchObject({
      documents: 6,
      read: 6,
    });
    for (const title of HIDDEN_TITLES)
      expect(batches.join('\n')).toContain(title);
  });

  it('AC-4: "Continuar varredura" drops a finding on a document that went up to CDC, recounts the coverage and never cites it', async () => {
    const { world, ana, llm } = await sweeping([]);
    await placeDocuments(world, { 'hermetismo:raw/ci-1.md': 'cdc' });
    const cursor: SweepCursor = {
      plan: PLAN,
      covered: coveredMark(['raw/ci-1.md', 'raw/qs-1.md']),
      totals: { documents: 4, scanned: 2, withHits: null, read: 2, batches: 1 },
      findings: [
        { id: 'raw/ci-1.md', text: 'Fala da lua escondida do meio' },
        { id: 'raw/qs-1.md', text: 'Fala da lua do primeiro grau' },
      ],
    };
    const before = llm.messagesSeen.length;
    const { body, stream } = await exhaustive(ana.call, { sweep: cursor });
    const coverage = coverageOf(stream);
    // Left: qs-1 (covered), qs-2 and the CI one in the sub-collection.
    expect(coverage).toMatchObject({ documents: 3, continued: true });
    const told = llm.messagesSeen
      .slice(before)
      .flat()
      .map((message) => message.content)
      .join('\n');
    expect(told).toContain('Fala da lua do primeiro grau');
    expect(told).not.toContain('Fala da lua escondida do meio');
    expect(body).not.toContain('Lua Media Uno');
    expect(body).not.toContain('raw/ci-1.md');
    expect(body).not.toContain('escondida');
  });

  it('NFR-2: with half of the set hidden the estimate is the requests made, give or take one', async () => {
    const { world, ana, llm } = await sweeping();
    await placeDocuments(world, { 'hermetismo:raw/qs-2.md': 'cdc' });
    const calls = llm.agentCalls.length;
    const { stream } = await exhaustive(ana.call);
    expect(coverageOf(stream).documents).toBe(3);
    const planned = plannedOf(stream);
    const made = llm.agentCalls.length - calls;
    expect(Math.abs((planned?.requests ?? 0) - made)).toBeLessThanOrEqual(1);
  });
});
