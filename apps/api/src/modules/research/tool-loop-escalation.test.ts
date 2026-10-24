import type { ResearchEvent } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import {
  answerText,
  collectEvents,
  escalatingRunner,
} from '../../../test/research-factories.js';
import type { StubReply } from '../../adapters/stub-llm-adapter.js';
import { DEEPEN_MARKER, deepenReason } from './escalation.js';

const input = (profile: 'fast' | 'deep' = 'fast') => ({
  topic: 'hermetismo',
  question: 'quais são os 5 princípios ocultos',
  history: [],
  profile,
  signal: new AbortController().signal,
});

const search: StubReply = {
  toolCalls: [{ name: 'search_collection', arguments: { query: 'ritmo' } }],
};

const ofType = <T extends ResearchEvent['type']>(
  events: readonly ResearchEvent[],
  type: T,
) =>
  events.filter(
    (e): e is Extract<ResearchEvent, { type: T }> => e.type === type,
  );

describe('auto-escalation from the fast to the deep profile (ADR 0009)', () => {
  it('hands the same turn to the deep model when the fast pass answers with the marker', async () => {
    const { runner, llm, deep, ledger } = await escalatingRunner(
      {
        script: [search, { text: `${DEEPEN_MARKER} a lista ficou incompleta` }],
      },
      {},
    );
    const events = await collectEvents(runner.run(input()));
    expect(llm.lastMessages[0]?.content).toContain(DEEPEN_MARKER);
    const steps = ofType(events, 'step').map((e) => e.step);
    expect(steps[1]).toEqual({
      kind: 'deepen',
      text: 'Aprofundando a pesquisa…',
    });
    // The marker never reaches the reader; the deep model writes the answer.
    expect(ofType(events, 'token').some((e) => e.text.includes('<<'))).toBe(
      false,
    );
    expect(answerText(events)).toMatch(/^Segundo o acervo, .*\[1\]\.$/);
    expect(deep.calls).toBeGreaterThan(0);
    expect(deep.lastMessages[0]?.content).toContain('no máximo 15 passos');
    expect(
      deep.lastMessages.some(
        (m) =>
          m.role === 'system' &&
          m.content.includes('a lista ficou incompleta') &&
          m.content.includes('mais 14 passos'),
      ),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      model: 'stub/deep',
      escalated: true,
    });
    expect(ledger.entries).toHaveLength(1);
  });

  it('escalates an answer that gives up on the collection, taking back what was shown', async () => {
    const { runner } = await escalatingRunner(
      {
        script: [
          search,
          { text: 'O acervo não nomeia os cinco princípios ocultos. ' },
        ],
      },
      {},
    );
    const events = await collectEvents(runner.run(input()));
    expect(ofType(events, 'retract')).toContainEqual({
      type: 'retract',
      segment: 0,
    });
    expect(answerText(events)).not.toContain('não nomeia');
    expect(ofType(events, 'done')[0]?.escalated).toBe(true);
  });

  it('keeps the fast answer when Settings turn escalation off, or in the deep profile', async () => {
    const off = await escalatingRunner(
      { script: [search, { text: 'O acervo não nomeia os cinco. ' }] },
      {},
      false,
    );
    const events = await collectEvents(off.runner.run(input()));
    expect(off.llm.lastMessages[0]?.content).not.toContain(DEEPEN_MARKER);
    expect(answerText(events)).toBe('O acervo não nomeia os cinco. ');
    expect(ofType(events, 'done')[0]).not.toHaveProperty('escalated');
    expect(off.deep.calls).toBe(0);
    const deepProfile = await escalatingRunner(
      { script: [search, { text: 'O acervo não nomeia os cinco. ' }] },
      {},
    );
    await collectEvents(deepProfile.runner.run(input('deep')));
    expect(deepProfile.deep.calls).toBe(0);
  });

  it('reads the reason after the marker and recognizes absence phrases', () => {
    expect(deepenOf(`${DEEPEN_MARKER} faltou a lista\nresto`)).toBe(
      'faltou a lista',
    );
    expect(deepenOf(DEEPEN_MARKER)).toBe('a pesquisa rápida não bastou');
    expect(deepenOf('Não há informações sobre isso.')).toMatch(/não há/i);
    expect(deepenOf('Não encontrei a lista.')).toMatch(/não encontrei/i);
    expect(deepenOf('Os cinco são descontinuidade e limite [1].')).toBeNull();
  });
});

const deepenOf = (text: string) => deepenReason(text);
