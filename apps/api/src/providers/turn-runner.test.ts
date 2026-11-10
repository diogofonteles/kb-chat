import type { ResearchEvent } from '@kb-chat/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ResearchRunnerPort } from '../ports/research-runner.js';
import { TurnScopedRunner } from './turn-runner.js';
import { OPEN_VIEW } from '../modules/access-levels/index.js';

const runner = (model: string): ResearchRunnerPort => ({
  model,
  billing: 'per-token',
  configured: () => true,
  run: async function* (): AsyncIterable<ResearchEvent> {
    yield { type: 'error', code: 'X' };
  },
});

describe('TurnScopedRunner (KBC-023 review M1)', () => {
  it('builds the turn only when it runs and finishes it once, whatever its end', async () => {
    const finish = vi.fn();
    const start = vi.fn(() => ({ runner: runner('turn'), finish }));
    const scoped = new TurnScopedRunner(runner('preview'), start);
    expect(scoped.configured()).toBe(true);
    expect(scoped.model).toBe('preview');
    expect(scoped.billing).toBe('per-token');
    expect(start).not.toHaveBeenCalled();
    const events = [];
    for await (const event of scoped.run({
      topic: 't',
      view: OPEN_VIEW,
      question: 'q',
      history: [],
      profile: 'fast',
      signal: new AbortController().signal,
    }))
      events.push(event);
    expect(events).toEqual([{ type: 'error', code: 'X' }]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
  });
});
