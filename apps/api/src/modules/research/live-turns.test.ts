import type { ResearchEvent } from '@kb-chat/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveTurns, type TurnFollower } from './live-turns.js';

const key = (turnId: string, conversationId = 'c1', principal = 'ana') => ({
  principal,
  conversationId,
  turnId,
});

const token = (text: string): ResearchEvent => ({
  type: 'token',
  text,
  segment: 0,
});

function recorder(): TurnFollower & { seen: ResearchEvent[]; ended: boolean } {
  const follower = {
    seen: [] as ResearchEvent[],
    ended: false,
    event: (event: ResearchEvent) => follower.seen.push(event),
    end: () => {
      follower.ended = true;
    },
  };
  return follower;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveTurns', () => {
  it('replays the events so far to a follower that comes back, then streams the rest and the end', () => {
    const turns = new LiveTurns();
    const turn = turns.start(key('t1'));
    turn.publish(token('A'));
    const late = recorder();
    turn.follow(late);
    turn.publish(token('B'));
    turns.end(turn);
    expect(late.seen).toEqual([token('A'), token('B')]);
    expect(late.ended).toBe(true);
    expect(turns.isLive('ana', 't1')).toBe(false);
  });

  it('a follower that leaves stops receiving, and the turn keeps running', () => {
    const turns = new LiveTurns();
    const turn = turns.start(key('t1'));
    const page = recorder();
    const leave = turn.follow(page);
    leave();
    turn.publish(token('A'));
    expect(page.seen).toEqual([]);
    expect(turn.abort.signal.aborted).toBe(false);
  });

  it('following a turn that already ended replays it and ends at once', () => {
    const turns = new LiveTurns();
    const turn = turns.start(key('t1'));
    turn.publish(token('A'));
    turns.end(turn);
    const late = recorder();
    turn.follow(late)();
    expect(late).toMatchObject({ seen: [token('A')], ended: true });
  });

  it('stops only the person’s own turn, and never finds another person’s', () => {
    const turns = new LiveTurns();
    const turn = turns.start(key('t1'));
    expect(turns.find('bia', 't1')).toBeNull();
    expect(turns.stop('bia', 't1')).toBe(false);
    expect(turn.abort.signal.aborted).toBe(false);
    expect(turns.stop('ana', 't1')).toBe(true);
    expect(turn.abort.signal.aborted).toBe(true);
    expect(turns.stop('ana', 'missing')).toBe(false);
  });

  it('a new turn in the same conversation stops the one still running', () => {
    const turns = new LiveTurns();
    const first = turns.start(key('t1'));
    const second = turns.start(key('t2'));
    expect(first.abort.signal.aborted).toBe(true);
    expect(second.abort.signal.aborted).toBe(false);
    turns.end(first);
    expect(turns.isLive('ana', 't2')).toBe(true);
  });

  it('stops a turn that runs past the ceiling', () => {
    vi.useFakeTimers();
    const turns = new LiveTurns({ ceilingMs: 1000 });
    const turn = turns.start(key('t1'));
    vi.advanceTimersByTime(999);
    expect(turn.abort.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(turn.abort.signal.aborted).toBe(true);
  });

  it('another person’s turn in a conversation with the same id is never stopped', () => {
    const turns = new LiveTurns();
    const mine = turns.start(key('t1'));
    turns.start(key('t2', 'c1', 'bia'));
    expect(mine.abort.signal.aborted).toBe(false);
  });

  it('keeps two people’s turns with the same id apart (QA BUG-1)', () => {
    const turns = new LiveTurns();
    const mine = turns.start(key('t1'));
    const theirs = turns.start(key('t1', 'c2', 'bia'));
    expect(turns.find('ana', 't1')).toBe(mine);
    expect(turns.find('bia', 't1')).toBe(theirs);
    turns.end(theirs);
    expect(turns.isLive('ana', 't1')).toBe(true);
  });

  it('closing stops every turn and waits for their runs to settle', async () => {
    const turns = new LiveTurns();
    const turn = turns.start(key('t1'));
    let saved = false;
    turns.track(
      new Promise<void>((resolve) =>
        turn.abort.signal.addEventListener('abort', () => {
          saved = true;
          resolve();
        }),
      ),
    );
    turns.track(Promise.reject(new Error('settled elsewhere')));
    await turns.close(5000);
    expect(saved).toBe(true);
  });
});
