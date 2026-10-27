import { Writable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { LiveTurns } from './live-turns.js';
import { followTurn } from './routes.js';

describe('followTurn (review MAJOR-2)', () => {
  it('returns at once when the page left while the turn was being saved', async () => {
    const raw = new Writable({
      write: (_chunk, _encoding, done) => done(),
    });
    const write = vi.spyOn(raw, 'write');
    raw.destroy();
    const reply = { raw, hijack: vi.fn() } as unknown as FastifyReply;
    const turns = new LiveTurns();
    const turn = turns.start({
      principal: 'ana',
      conversationId: 'c1',
      turnId: 't1',
    });
    await followTurn(reply, turn);
    turn.publish({ type: 'token', text: 'x', segment: 0 });
    expect(reply.hijack).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    turns.end(turn);
  });
});
