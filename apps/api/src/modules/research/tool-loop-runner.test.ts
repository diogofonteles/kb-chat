import type { ResearchEvent } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import {
  answerText,
  collectEvents,
  fixtureRunner,
} from '../../../test/research-factories.js';
import type { StubReply } from '../../adapters/stub-llm-adapter.js';
import type { AgentChunk, AgentMessage } from '../../ports/llm.js';
import { MAX_OUTPUT_TOKENS, MAX_TOOL_STEPS } from './limits.js';
import { NARRATION_HOLD_CHARS } from './tool-loop-runner.js';

const input = (question: string, signal = new AbortController().signal) => ({
  topic: 'hermetismo',
  question,
  history: [],
  signal,
});

const searchReply = (...queries: string[]): StubReply => ({
  toolCalls: queries.map((query) => ({
    name: 'search_collection',
    arguments: { query },
  })),
});

const ofType = <T extends ResearchEvent['type']>(
  events: readonly ResearchEvent[],
  type: T,
) =>
  events.filter(
    (e): e is Extract<ResearchEvent, { type: T }> => e.type === type,
  );

describe('ToolLoopRunner', () => {
  it('searches again with other words when the first search finds nothing and cites what it read (AC-1)', async () => {
    const { runner, llm, ledger } = await fixtureRunner();
    const events = await collectEvents(runner.run(input('pitagóricos')));
    // A short answer is held back like a preamble until the call ends, so it arrives whole.
    expect(events.map((e) => e.type)).toEqual([
      'step',
      'step',
      'sources',
      'step',
      'token',
      'done',
    ]);
    expect(ofType(events, 'step').map((e) => e.step.text)).toEqual([
      'Buscando “xqzw kplvm”',
      'Buscando “pitagóricos”',
      'Lendo “A Lei do Ritmo”',
    ]);
    expect(ofType(events, 'sources')[0]?.sources[0]).toEqual({
      n: 1,
      id: 'raw/articles/a-lei-do-ritmo.md',
      title: 'A Lei do Ritmo',
    });
    expect(answerText(events)).toBe(
      'Segundo o acervo, “A Lei do Ritmo” trata do assunto [1].',
    );
    const done = ofType(events, 'done')[0];
    expect(done).toMatchObject({
      model: 'stub/model',
      interrupted: false,
      steps: 3,
    });
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]?.usd).toBeCloseTo(done?.usd ?? -1, 10);
    expect(llm.agentCalls.map((o) => [o.toolChoice, o.maxTokens])).toEqual(
      Array.from({ length: 4 }, () => ['auto', MAX_OUTPUT_TOKENS]),
    );
  });

  it('stops at 15 tool steps and answers with what it has (AC-7)', async () => {
    const script = Array.from({ length: 20 }, (_, i) =>
      searchReply(`ritmo ${i}`),
    );
    const { runner, llm } = await fixtureRunner({ script });
    const events = await collectEvents(runner.run(input('ritmo')));
    expect(MAX_TOOL_STEPS).toBe(15);
    expect(ofType(events, 'step')).toHaveLength(15);
    expect(ofType(events, 'done')[0]?.steps).toBe(15);
    expect(llm.agentCalls).toHaveLength(16);
    expect(llm.agentCalls.at(-1)?.toolChoice).toBe('none');
    expect(answerText(events)).toMatch(/\[\d+\]\.$/);
  });

  it('runs parallel calls and answers the ones over the budget as skipped', async () => {
    const batch = searchReply('ritmo', 'natureza', 'cabala', 'vida');
    const { runner, llm } = await fixtureRunner({
      script: [batch, batch, batch, batch],
    });
    const events = await collectEvents(runner.run(input('ritmo')));
    expect(ofType(events, 'step')).toHaveLength(15);
    const skipped = llm.lastMessages.filter(
      (m) => m.role === 'tool' && m.content.startsWith('Não executada'),
    );
    expect(skipped).toHaveLength(1);
  });

  it('stops before the next model call when the daily cap is reached mid-way (AC-4)', async () => {
    const script = [
      searchReply('ritmo'),
      searchReply('natureza'),
      searchReply('cabala'),
    ];
    const { runner, ledger } = await fixtureRunner(
      { script, usdPerCall: 0.6 },
      1,
    );
    const events = await collectEvents(runner.run(input('ritmo')));
    expect(events.at(-1)).toEqual({ type: 'error', code: 'DAILY_CAP_REACHED' });
    expect(ofType(events, 'step')).toHaveLength(2);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ usd: 1.2, interrupted: true });
  });

  it('refuses before any spend when the cap or the credit is already exhausted', async () => {
    const capped = await fixtureRunner({}, 0);
    expect(await collectEvents(capped.runner.run(input('ritmo')))).toEqual([
      { type: 'error', code: 'DAILY_CAP_REACHED' },
    ]);
    expect(capped.ledger.entries).toHaveLength(0);
    const broke = await fixtureRunner({ balance: 0 });
    expect(await collectEvents(broke.runner.run(input('ritmo')))).toEqual([
      { type: 'error', code: 'LLM_INSUFFICIENT_CREDIT' },
    ]);
  });

  it('makes no further model call once aborted and records the turn as interrupted', async () => {
    const { runner, ledger, llm } = await fixtureRunner();
    const abort = new AbortController();
    const events: ResearchEvent[] = [];
    for await (const event of runner.run(input('pitagóricos', abort.signal))) {
      events.push(event);
      if (event.type === 'step' && event.step.kind === 'read') abort.abort();
    }
    expect(llm.agentCalls).toHaveLength(3);
    expect(ofType(events, 'token')).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      interrupted: true,
      steps: 3,
    });
    expect(ledger.entries[0]).toMatchObject({ interrupted: true });
  });

  it('stops a streaming answer on abort and prices the unreported usage', async () => {
    const script = [{ text: 'palavra '.repeat(300) }];
    const { runner, ledger, llm } = await fixtureRunner({
      script,
      tokenDelayMs: 1,
    });
    const abort = new AbortController();
    const events: ResearchEvent[] = [];
    for await (const event of runner.run(input('ritmo', abort.signal))) {
      events.push(event);
      if (event.type === 'token') abort.abort();
    }
    expect(llm.yielded).toBeLessThan(150);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      interrupted: true,
      steps: 0,
    });
    expect(ledger.entries[0]?.usd).toBeGreaterThan(0);
  });

  it('reports a provider failure as an error event and still records the spend', async () => {
    const { runner, llm, ledger } = await fixtureRunner();
    llm.streamAgent = async function* (): AsyncIterable<AgentChunk> {
      yield {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 0, usd: 0.01 },
      };
      throw new Error('provider down');
    };
    const events = await collectEvents(runner.run(input('ritmo')));
    expect(events).toEqual([{ type: 'error', code: 'INTERNAL' }]);
    expect(ledger.entries[0]).toMatchObject({ usd: 0.01, interrupted: true });
  });

  it('never shows the text of a call that ends with tool calls, however long', async () => {
    const { runner, llm } = await fixtureRunner();
    const narration =
      'Os documentos mais promissores são [1] e [2]. Vou lê-los agora. ';
    let calls = 0;
    let seen: readonly AgentMessage[] = [];
    llm.streamAgent = async function* (messages): AsyncIterable<AgentChunk> {
      calls += 1;
      seen = [...messages];
      if (calls > 1) return yield { type: 'token', text: 'Resposta.' };
      for (let i = 0; i < 10; i += 1) yield { type: 'token', text: narration };
      yield {
        type: 'tool_call',
        call: { id: 'a', name: 'list_subjects', arguments: '' },
      };
    };
    const events = await collectEvents(runner.run(input('ritmo')));
    expect(narration.repeat(10).length).toBeLessThan(NARRATION_HOLD_CHARS);
    expect(answerText(events)).toBe('Resposta.');
    expect(ofType(events, 'step')[0]?.step.kind).toBe('subjects');
    // The model keeps what it wrote; only the reader does not see it.
    expect(seen.at(-2)).toMatchObject({
      role: 'assistant',
      content: narration.repeat(10),
    });
  });

  it('streams a long final answer in chunks once it passes the hold size', async () => {
    const answer = 'O ritmo governa os ciclos do cosmos [1]. '.repeat(60);
    const { runner } = await fixtureRunner({ script: [{ text: answer }] });
    const events = await collectEvents(runner.run(input('ritmo')));
    const tokens = ofType(events, 'token');
    expect(answerText(events)).toBe(answer);
    expect(tokens.length).toBeGreaterThan(100);
    expect(tokens[0]?.text.length).toBeGreaterThanOrEqual(NARRATION_HOLD_CHARS);
    expect(tokens[0]?.text.length).toBeLessThan(NARRATION_HOLD_CHARS + 50);
  });

  it('keeps a streamed answer as the answer and ignores tool calls asked after it', async () => {
    const { runner, llm } = await fixtureRunner();
    const long = 'Contexto do acervo. '.repeat(50);
    llm.streamAgent = async function* (): AsyncIterable<AgentChunk> {
      yield { type: 'token', text: long };
      yield {
        type: 'tool_call',
        call: { id: 'a', name: 'list_subjects', arguments: '{}' },
      };
    };
    const events = await collectEvents(runner.run(input('ritmo')));
    expect(answerText(events)).toBe(long);
    expect(ofType(events, 'step')).toHaveLength(0);
    expect(ofType(events, 'done')[0]?.steps).toBe(0);
  });

  it('writes a fallback when the model ends without text', async () => {
    const { runner } = await fixtureRunner({ script: [{ text: '' }] });
    const events = await collectEvents(runner.run(input('ritmo')));
    expect(answerText(events)).toMatch(/^Não consegui escrever uma resposta/);
  });

  it('sends the conversation so far as prior turns and refuses an unknown topic', async () => {
    const { runner, llm } = await fixtureRunner({ script: [{ text: 'Ok.' }] });
    await collectEvents(
      runner.run({
        ...input('e os outros?'),
        history: [
          { question: 'quais são os princípios?', answer: 'São sete [1].' },
        ],
      }),
    );
    expect(
      llm.lastMessages.map((m) => [m.role, m.content.slice(0, 20)]),
    ).toEqual([
      ['system', expect.any(String)],
      ['user', 'quais são os princíp'],
      ['assistant', 'São sete [1].'],
      ['user', 'e os outros?'],
    ]);
    expect(
      await collectEvents(runner.run({ ...input('x'), topic: 'nope' })),
    ).toEqual([{ type: 'error', code: 'TOPIC_NOT_FOUND' }]);
    expect(runner.model).toBe('stub/model');
    expect(runner.billing).toBe('per-token');
    expect(runner.configured()).toBe(true);
  });
});
