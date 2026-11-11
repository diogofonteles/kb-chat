import { describe, expect, it, vi } from 'vitest';
import { applyAll, type UndoableStep } from './undo-steps.js';

const step = (name: string, trace: string[], fails = false): UndoableStep => ({
  name,
  apply: async () => {
    if (fails) throw new Error(`${name} failed`);
    trace.push(`apply ${name}`);
    return async () => {
      trace.push(`undo ${name}`);
    };
  },
});

describe('applyAll (KBC-108 NFR-2)', () => {
  it('undoes the steps written, newest first, when a later one fails', async () => {
    const trace: string[] = [];
    const log = { error: vi.fn() };
    await expect(
      applyAll(
        [step('a', trace), step('b', trace), step('c', trace, true)],
        log,
      ),
    ).rejects.toThrow('c failed');
    expect(trace).toEqual(['apply a', 'apply b', 'undo b', 'undo a']);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs an undo that fails and still runs the others', async () => {
    const trace: string[] = [];
    const log = { error: vi.fn() };
    const broken: UndoableStep = {
      name: 'b',
      apply: async () => async () => {
        throw new Error('disk gone');
      },
    };
    await expect(
      applyAll([step('a', trace), broken, step('c', trace, true)], log),
    ).rejects.toThrow('c failed');
    expect(trace).toEqual(['apply a', 'undo a']);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'b' }),
      'level change rolled back incompletely',
    );
  });
});
