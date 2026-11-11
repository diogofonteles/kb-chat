import type { ResearchEvent, SavedResearchTurn } from '@kb-chat/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../logger.js';
import type {
  ResearchInput,
  ResearchRunnerPort,
} from '../../ports/research-runner.js';
import { LiveTurns } from './live-turns.js';
import { runRecorded, type RecordedCall } from './routes.js';
import { pendingTurn } from './turn-record.js';
import { OPEN_VIEW } from '../access-levels/index.js';

/** A runner that, once stopped, takes until `release` to end (a slow provider abort). */
function slowToStop() {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => (release = resolve));
  const runner: ResearchRunnerPort = {
    model: 'm',
    billing: 'per-token',
    configured: () => true,
    async *run(input: ResearchInput): AsyncIterable<ResearchEvent> {
      yield { type: 'token', text: 'Começo', segment: 0 };
      if (!input.signal.aborted)
        await new Promise((resolve) =>
          input.signal.addEventListener('abort', resolve, { once: true }),
        );
      await released;
      yield {
        type: 'done',
        usd: 0,
        billing: 'per-token',
        model: 'm',
        interrupted: true,
        steps: 0,
      };
    },
  };
  return { runner, release };
}

const call: RecordedCall = {
  topic: 'hermetismo',
  view: OPEN_VIEW,
  principal: 'ana',
  conversationId: 'c1',
  turnId: 't1',
  body: { question: 'ritmo', history: [], profile: 'fast' },
};

describe('runRecorded (QA BUG-2)', () => {
  it('does not record the end of an attempt that "Tentar de novo" took over', async () => {
    const turns = new LiveTurns();
    const journal = {
      beginTurn: vi.fn(async () => undefined),
      finishTurn: vi.fn<
        (p: string, c: string, t: SavedResearchTurn) => Promise<void>
      >(async () => undefined),
    };
    const { runner, release } = slowToStop();
    const turn = turns.start(call);
    const pending = pendingTurn({
      ...call.body,
      id: 't1',
      at: new Date().toISOString(),
    });
    const log = createLogger('silent');
    const run = runRecorded(
      { runner, call, turn, pending, log },
      { journal, turns },
    );
    turns.stop('ana', 't1');
    const retry = turns.start(call);
    release();
    await run;
    expect(journal.finishTurn).not.toHaveBeenCalled();
    expect(turns.find('ana', 't1')).toBe(retry);
  });

  it('records the end of the attempt that still owns its turn id', async () => {
    const turns = new LiveTurns();
    const journal = {
      beginTurn: vi.fn(async () => undefined),
      finishTurn: vi.fn(async () => undefined),
    };
    const { runner, release } = slowToStop();
    const turn = turns.start(call);
    const pending = pendingTurn({
      ...call.body,
      id: 't1',
      at: new Date().toISOString(),
    });
    const log = createLogger('silent');
    const run = runRecorded(
      { runner, call, turn, pending, log },
      { journal, turns },
    );
    turns.stop('ana', 't1');
    release();
    await run;
    expect(journal.finishTurn).toHaveBeenCalledWith(
      'ana',
      'c1',
      expect.objectContaining({
        id: 't1',
        interrupted: true,
        answer: 'Começo',
      }),
    );
  });
});
