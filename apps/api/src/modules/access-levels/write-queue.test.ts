import { describe, expect, it } from 'vitest';
import { LevelWriteQueue } from './write-queue.js';

describe('LevelWriteQueue (KBC-107 R1-7, R2-6)', () => {
  it('runs work in the order it was queued, each after the previous one ended', async () => {
    const queue = new LevelWriteQueue();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const first = queue.run(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      order.push('first');
    });
    const second = queue.run(async () => {
      order.push('second');
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('a failure reaches its caller and never stops the work after it; settled waits for all', async () => {
    const queue = new LevelWriteQueue();
    const failed = queue.run(() => Promise.reject(new Error('disk full')));
    let done = false;
    const after = queue.run(async () => {
      done = true;
      return 'ok';
    });
    await expect(failed).rejects.toThrow('disk full');
    await queue.settled();
    expect(done).toBe(true);
    expect(await after).toBe('ok');
  });
});
