import type { ResearchEvent, ResearchProfile } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import {
  answerText,
  collectEvents,
  fixtureRunner,
} from '../../../test/research-factories.js';
import type { StubReply } from '../../adapters/stub-llm-adapter.js';
import { researchBudgets } from './limits.js';
import { inPool } from './subagents.js';

const input = (
  question: string,
  profile: ResearchProfile = 'exhaustive',
  signal = new AbortController().signal,
) => ({ topic: 'hermetismo', question, history: [], profile, signal });

const delegate = (count: number): StubReply => ({
  toolCalls: [
    {
      name: 'delegate',
      arguments: {
        tasks: Array.from({ length: count }, (_, i) => ({
          title: `Parte ${i + 1}`,
          task: `Pesquise o ritmo, parte ${i + 1}`,
        })),
      },
    },
  ],
});

const ofType = <T extends ResearchEvent['type']>(
  events: readonly ResearchEvent[],
  type: T,
) =>
  events.filter(
    (e): e is Extract<ResearchEvent, { type: T }> => e.type === type,
  );

describe('sub-researchers (KBC-018, ADR 0014)', () => {
  it('offers delegate only to the exhaustive orchestrator (AC-1)', async () => {
    const exhaustive = await fixtureRunner({ script: [] });
    await collectEvents(exhaustive.runner.run(input('ritmo')));
    expect(exhaustive.llm.lastTools).toContain('delegate');
    const deep = await fixtureRunner({ script: [delegate(1)] });
    await collectEvents(deep.runner.run(input('ritmo', 'deep')));
    expect(deep.llm.lastTools).not.toContain('delegate');
    const refused = deep.llm.lastMessages.find((m) => m.role === 'tool');
    expect(refused?.content).toBe('Ferramenta desconhecida: delegate.');
    expect(deep.llm.subCalls).toBe(0);
  });

  it('runs the tasks on sub-researchers that share the numbering and report back (AC-2, AC-4)', async () => {
    const { runner, llm } = await fixtureRunner({ script: [delegate(3)] });
    const events = await collectEvents(runner.run(input('ritmo')));
    const steps = ofType(events, 'step').map((e) => e.step);
    expect(steps.filter((s) => s.kind === 'delegate')).toEqual([
      { kind: 'delegate', text: 'Parte 1', agent: 1 },
      { kind: 'delegate', text: 'Parte 2', agent: 2 },
      { kind: 'delegate', text: 'Parte 3', agent: 3 },
    ]);
    // Each sub-researcher searched twice and read once (the default script).
    for (const agent of [1, 2, 3])
      expect(steps.filter((s) => s.agent === agent)).toHaveLength(4);
    const reports = llm.lastMessages.find((m) => m.role === 'tool')?.content;
    expect(reports).toMatch(/### Pesquisador 1 — Parte 1\nSegundo o acervo/);
    expect(reports).toContain('### Pesquisador 3 — Parte 3');
    const sources = ofType(events, 'sources').at(-1)?.sources ?? [];
    const cited = Number(/\[(\d+)\]/.exec(answerText(events))?.[1]);
    expect(sources.some((s) => s.n === cited)).toBe(true);
    expect(ofType(events, 'done')[0]?.steps).toBe(1 + 9);
  });

  it('never runs more than 3 at once and overlaps them (AC-3)', async () => {
    const { runner, llm } = await fixtureRunner({
      script: [delegate(5)],
      subScript: [],
      callDelayMs: 50,
    });
    const started = performance.now();
    await collectEvents(runner.run(input('ritmo')));
    const elapsed = performance.now() - started;
    expect(llm.subCalls).toBe(5);
    expect(llm.maxActive).toBe(3);
    // Two rounds of sub-researchers plus the orchestrator's two calls, not five in a row.
    expect(elapsed).toBeLessThan(5 * 50 + 2 * 50);
  });

  it('keeps a sub-researcher text away from the reader (AC-7)', async () => {
    const { runner } = await fixtureRunner({
      script: [delegate(2)],
      subScript: [{ text: 'Texto interno do sub-pesquisador [1].' }],
      finalText: 'Resposta final.',
    });
    const events = await collectEvents(runner.run(input('ritmo')));
    const tokens = ofType(events, 'token')
      .map((e) => e.text)
      .join('');
    expect(tokens).not.toContain('Texto interno');
  });

  it('stops every sub-researcher when the reader stops (AC-5)', async () => {
    const abort = new AbortController();
    const { runner, llm } = await fixtureRunner({
      script: [delegate(3)],
      callDelayMs: 20,
    });
    const events: ResearchEvent[] = [];
    let callsAtStop = 0;
    for await (const event of runner.run(
      input('ritmo', 'exhaustive', abort.signal),
    )) {
      events.push(event);
      if (event.type === 'step' && event.step.agent && !abort.signal.aborted) {
        callsAtStop = llm.calls;
        abort.abort();
      }
    }
    expect(events.at(-1)).toMatchObject({ type: 'done', interrupted: true });
    // Calls already running may finish; none starts after the stop.
    expect(llm.calls).toBeLessThanOrEqual(callsAtStop + 3);
    expect(llm.subCalls).toBeLessThan(3 * 4);
  });

  it('ends the turn at the daily cap, counting what the sub-researchers spent (AC-6)', async () => {
    const { runner, ledger } = await fixtureRunner(
      { script: [delegate(3)], usdPerCall: 0.3 },
      1,
    );
    const events = await collectEvents(runner.run(input('ritmo')));
    expect(events.at(-1)).toEqual({ type: 'error', code: 'DAILY_CAP_REACHED' });
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]?.interrupted).toBe(true);
    expect(ledger.entries[0]?.usd).toBeGreaterThanOrEqual(0.9);
  });
});

describe('sub-researcher budgets', () => {
  it('stops granting tool steps past the turn total and still reports', async () => {
    const budgets = researchBudgets();
    const delegation = budgets.exhaustive.delegation;
    if (!delegation) throw new Error('exhaustive delegates');
    const tight = {
      ...budgets,
      exhaustive: {
        ...budgets.exhaustive,
        delegation: { ...delegation, totalSteps: 2 },
      },
    };
    const { runner, llm } = await fixtureRunner(
      { script: [delegate(3)] },
      1,
      tight,
    );
    const events = await collectEvents(runner.run(input('ritmo')));
    expect(ofType(events, 'done')[0]?.steps).toBe(1 + 2);
    const reports = llm.lastMessages.find((m) => m.role === 'tool')?.content;
    expect(reports?.match(/### Pesquisador/g)).toHaveLength(3);
  });
});

describe('inPool', () => {
  it('keeps the input order and the concurrency bound', async () => {
    let active = 0;
    let most = 0;
    const out = await inPool([30, 10, 20, 5], 2, async (ms) => {
      active += 1;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, ms));
      active -= 1;
      return ms * 2;
    });
    expect(out).toEqual([60, 20, 40, 10]);
    expect(most).toBe(2);
  });
});
