import type {
  ResearchEvent,
  ResearchProfile,
  SweepCursor,
} from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import {
  answerText,
  collectEvents,
  fixtureTools,
} from '../../../../test/research-factories.js';
import { MemorySpendLedger } from '../../../adapters/memory-spend-ledger.js';
import {
  StubLlmAdapter,
  type StubLlmOptions,
} from '../../../adapters/stub-llm-adapter.js';
import { SpendService } from '../../spend/index.js';
import { researchBudgets, type ResearchBudgets } from '../limits.js';
import { ToolLoopRunner } from '../tool-loop-runner.js';
import { PLAN_STEPS, PLAN_SWEEP_TOOL } from './plan-tool.js';
import { SweepPacer } from './sweep-pacing.js';

/** The fixture vault's documents marked as the Mestre's (author_group: mestre-laercio). */
const MESTRE_DOCS = 14;
const QUESTION = 'Quais livros o Mestre Laércio cita como referência?';
/** A question that does not name the Mestre: the default plan sweeps the whole topic. */
const WHOLE = 'Liste tudo o que o acervo diz sobre os princípios';

const ofType = <T extends ResearchEvent['type']>(
  events: readonly ResearchEvent[],
  type: T,
) =>
  events.filter(
    (e): e is Extract<ResearchEvent, { type: T }> => e.type === type,
  );

interface Setup {
  readonly llm?: StubLlmOptions;
  readonly cap?: number;
  readonly budgets?: ResearchBudgets;
  readonly pacer?: SweepPacer;
}

async function sweepRunner({
  llm: options = {},
  cap = 5,
  budgets,
  pacer,
}: Setup = {}) {
  const llm = new StubLlmAdapter(options);
  const ledger = new MemorySpendLedger();
  const spend = new SpendService({
    llm,
    ledger,
    dailyCapUsd: () => cap,
    principal: 'owner',
  });
  const tools = await fixtureTools();
  const runner = new ToolLoopRunner({ llm, tools, spend, budgets, pacer });
  return { runner, llm, ledger };
}

const exhaustive = (
  extra: {
    signal?: AbortSignal;
    sweep?: SweepCursor;
    requestBudget?: number;
    profile?: ResearchProfile;
    question?: string;
  } = {},
) => ({
  topic: 'hermetismo',
  question: extra.question ?? QUESTION,
  history: [],
  profile: extra.profile ?? ('exhaustive' as const),
  signal: extra.signal ?? new AbortController().signal,
  ...(extra.sweep && { sweep: extra.sweep }),
  ...(extra.requestBudget !== undefined && {
    requestBudget: extra.requestBudget,
  }),
});

const done = (events: readonly ResearchEvent[]) => {
  const last = ofType(events, 'done')[0];
  if (!last) throw new Error(`no done: ${JSON.stringify(events.at(-1))}`);
  return last;
};

/** Every document id a batch call received, from the stub's recorded batch prompts. */
const LAZY = {
  script: [
    {
      text: 'Ele cita O Caibalion [1].\n**Cobertura:** varri 2.555 documentos de autoria Mestre Laércio.',
    },
  ],
};

describe('exhaustive sweep in the in-API loop (KBC-030)', () => {
  it('sweeps the whole set even when the model tries to answer at once (lazy model)', async () => {
    const { runner, llm } = await sweepRunner({ llm: LAZY });
    const events = await collectEvents(runner.run(exhaustive()));
    // The lazy text was taken back, the default plan (the Mestre's documents) swept.
    expect(ofType(events, 'retract').length).toBeGreaterThan(0);
    const planned = ofType(events, 'sweep')[0]?.sweep;
    expect(planned).toMatchObject({
      status: 'planned',
      documents: MESTRE_DOCS,
    });
    const coverage = done(events).coverage;
    expect(coverage).toMatchObject({
      target: { authorship: 'mestre-laercio' },
      documents: MESTRE_DOCS,
      scanned: MESTRE_DOCS,
      read: MESTRE_DOCS,
      missing: 0,
    });
    expect(llm.batchCalls).toBe(planned?.batches);
    // The answer is asked for only after every batch, without tools.
    expect(llm.agentCalls.at(-1)?.toolChoice).toBe('none');
    expect(done(events).sweep).toBeUndefined();
    expect(answerText(events)).not.toContain('2.555');
  });

  it('never shows a coverage line the model writes; the coverage is the measured one', async () => {
    const { runner } = await sweepRunner({
      llm: {
        finalText:
          'Os livros: O Caibalion [1].\n\n**Cobertura:** varri 2.555 documentos de 2.555.\n',
      },
    });
    const events = await collectEvents(
      runner.run(exhaustive({ question: WHOLE })),
    );
    const answer = answerText(events);
    expect(answer).toContain('O Caibalion [1]');
    expect(answer).not.toMatch(/cobertura/i);
    const coverage = done(events).coverage;
    expect(coverage?.documents).toBeGreaterThan(MESTRE_DOCS);
    expect(coverage?.read).toBe(coverage?.documents);
    expect(coverage?.missing).toBe(0);
  });

  it('plans with plan_sweep, scans by the phrases and reads only documents with them', async () => {
    const { runner, llm } = await sweepRunner({
      llm: {
        script: [
          {
            toolCalls: [
              {
                name: PLAN_SWEEP_TOOL,
                arguments: {
                  target: { authorship: 'mestre-laercio' },
                  phrases: ['ritmo'],
                  extract: 'o que diz da vibração',
                },
              },
            ],
          },
        ],
      },
    });
    const events = await collectEvents(runner.run(exhaustive()));
    expect(llm.toolsSeen[0]).toContain(PLAN_SWEEP_TOOL);
    // The answer comes from the findings only.
    expect(llm.lastTools).toEqual([]);
    const coverage = done(events).coverage;
    expect(coverage?.scanned).toBe(MESTRE_DOCS);
    expect(coverage?.withHits).toBeGreaterThan(0);
    expect(coverage?.withHits).toBeLessThanOrEqual(MESTRE_DOCS);
    expect(coverage?.read).toBe(coverage?.withHits);
    expect(coverage?.phrases).toEqual(['ritmo']);
    expect(ofType(events, 'step').map((s) => s.step.kind)).toContain('sweep');
  });

  it('stops at the request budget with a cursor, still answers, and a continuation finishes', async () => {
    const budgets = researchBudgets({ sweepRequests: 3 });
    const first = await sweepRunner({ llm: LAZY, budgets });
    const events = await collectEvents(
      first.runner.run(exhaustive({ question: WHOLE })),
    );
    const cursor = done(events).sweep;
    expect(done(events).coverage).toMatchObject({ reason: 'requests' });
    expect(done(events).coverage?.missing).toBeGreaterThan(0);
    expect(cursor?.plan.target).toEqual({});
    expect(answerText(events)).not.toBe('');
    const rest = await sweepRunner();
    const more = await collectEvents(
      rest.runner.run(exhaustive({ question: WHOLE, sweep: cursor })),
    );
    expect(rest.llm.lastTools).toEqual([]);
    const total = done(more).coverage;
    expect(total?.read).toBe(total?.documents);
    expect(total?.missing).toBe(0);
    expect(total?.batches).toBeGreaterThan(rest.llm.batchCalls);
    expect(done(more).sweep).toBeUndefined();
  });

  it('keeps to the requests the house has left', async () => {
    const { runner, llm } = await sweepRunner({ llm: LAZY });
    const events = await collectEvents(
      runner.run(exhaustive({ question: WHOLE, requestBudget: 3 })),
    );
    expect(llm.calls).toBeLessThanOrEqual(3);
    expect(done(events).coverage?.reason).toBe('requests');
  });

  it('keeps the answer within the daily cap: the sweep stops first', async () => {
    const { runner } = await sweepRunner({
      llm: { ...LAZY, usdPerCall: 0.02 },
      cap: 0.07,
    });
    const events = await collectEvents(
      runner.run(exhaustive({ question: WHOLE })),
    );
    expect(done(events).coverage?.reason).toBe('spend');
    expect(answerText(events)).not.toBe('');
  });

  it('stops everything on Parar: no answer, the coverage and cursor kept', async () => {
    const abort = new AbortController();
    let batches = 0;
    const { runner, llm } = await sweepRunner({
      llm: {
        ...LAZY,
        batchReply: () => {
          batches += 1;
          if (batches === 1) abort.abort();
          return 'NENHUM';
        },
      },
    });
    const events = await collectEvents(
      runner.run(exhaustive({ question: WHOLE, signal: abort.signal })),
    );
    const end = done(events);
    expect(end.interrupted).toBe(true);
    expect(end.coverage?.reason).toBe('stopped');
    expect(end.sweep).toBeDefined();
    expect(
      llm.agentCalls.some(
        (c) => c.toolChoice === 'none' && c.maxTokens > 4_000,
      ),
    ).toBe(false);
  });

  it('gives up planning after its steps and sweeps with the default plan', async () => {
    const pages = Array.from({ length: 30 }, (_, i) => ({
      toolCalls: [
        { name: 'find_text', arguments: { phrase: 'ritmo', offset: i } },
      ],
    }));
    const { runner } = await sweepRunner({ llm: { script: pages } });
    const events = await collectEvents(runner.run(exhaustive()));
    expect(done(events).steps).toBe(PLAN_STEPS);
    expect(done(events).coverage?.missing).toBe(0);
  });

  it('leaves the deep profile as it was: no plan_sweep, no sweep', async () => {
    const { runner, llm } = await sweepRunner();
    const events = await collectEvents(
      runner.run(exhaustive({ profile: 'deep' })),
    );
    expect(llm.lastTools).not.toContain(PLAN_SWEEP_TOOL);
    expect(ofType(events, 'sweep')).toHaveLength(0);
    expect(done(events).coverage).toBeUndefined();
  });

  it('keeps the findings made before Parar and answers the continuation with them (QA F-1)', async () => {
    const abort = new AbortController();
    let calls = 0;
    const stopped = await sweepRunner({
      llm: {
        ...LAZY,
        batchReply: (user) => {
          calls += 1;
          // The reader stops while the second batch runs.
          if (calls === 2) abort.abort();
          const title = /^\[D1\] ([^·\n]+)/m.exec(user)?.[1]?.trim() ?? '?';
          return `- [D1] Achado antes de parar em ${title}`;
        },
      },
    });
    const events = await collectEvents(
      stopped.runner.run(exhaustive({ question: WHOLE, signal: abort.signal })),
    );
    const cursor = done(events).sweep;
    expect(cursor?.findings[0]?.text).toMatch(/Achado antes de parar/);
    const rest = await sweepRunner({ llm: { batchReply: () => 'NENHUM' } });
    await collectEvents(
      rest.runner.run(exhaustive({ question: WHOLE, sweep: cursor })),
    );
    const answerCall = rest.llm.messagesSeen.at(-1) ?? [];
    expect(answerCall.at(-1)?.content).toMatch(/Achado antes de parar/);
  });

  it('paces a free model’s batches with the pacer it is given (review round 4)', async () => {
    let waits = 0;
    const pacer = new (class extends SweepPacer {
      override async wait() {
        waits += 1;
      }
    })();
    const { runner, llm } = await sweepRunner({
      llm: { ...LAZY, price: { input: 0, output: 0 } },
      pacer,
    });
    await collectEvents(runner.run(exhaustive({ question: WHOLE })));
    expect(waits).toBe(llm.batchCalls);
    expect(waits).toBeGreaterThan(0);
  });
});
