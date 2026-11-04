import { describe, expect, it } from 'vitest';
import { HISTORY_LIMIT, UndoHistory } from './undo-history.js';

describe('UndoHistory (KBC-066 FR-7)', () => {
  it('walks back and forth over the recorded states', () => {
    const history = new UndoHistory<string>();
    history.record('a');
    history.record('b');
    expect(history.undo('c')).toBe('b');
    expect(history.undo('b')).toBe('a');
    expect(history.undo('a')).toBeNull();
    expect(history.redo('a')).toBe('b');
    expect(history.redo('b')).toBe('c');
    expect(history.redo('c')).toBeNull();
  });

  it('forgets what could be redone after a new change', () => {
    const history = new UndoHistory<string>();
    history.record('a');
    history.undo('b');
    history.record('a');
    expect(history.canRedo).toBe(false);
  });

  it('keeps at most 100 steps', () => {
    const history = new UndoHistory<number>();
    for (let step = 0; step < HISTORY_LIMIT + 20; step += 1)
      history.record(step);
    let steps = 0;
    let state: number | null = -1;
    while (state !== null) {
      state = history.undo(state);
      if (state !== null) steps += 1;
    }
    expect(steps).toBe(HISTORY_LIMIT);
  });
});
