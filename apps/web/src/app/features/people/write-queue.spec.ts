import { ErrorHandler, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { WriteQueue } from './write-queue.js';

class RecordingErrorHandler extends ErrorHandler {
  readonly seen: unknown[] = [];
  override handleError(error: unknown): void {
    this.seen.push(error);
  }
}

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: ErrorHandler, useClass: RecordingErrorHandler },
    ],
  });
  const queue = TestBed.runInInjectionContext(() => new WriteQueue());
  const errors = TestBed.inject(ErrorHandler) as RecordingErrorHandler;
  return { queue, errors };
}

describe('WriteQueue (KBC-062)', () => {
  it('runs one write at a time, in order, busy while any waits', () => {
    const { queue } = setup();
    const first = new Subject<string>();
    const seen: string[] = [];

    queue.run(() => first, { done: (v) => seen.push(v), failed: vi.fn() });
    queue.run(() => of('second'), {
      done: (v) => seen.push(v),
      failed: vi.fn(),
    });
    expect(queue.busy()).toBe(true);
    expect(seen).toEqual([]);

    first.next('first');
    first.complete();

    expect(seen).toEqual(['first', 'second']);
    expect(queue.busy()).toBe(false);
  });

  it('is busy for a key only while a write of that key waits', () => {
    const { queue } = setup();
    const write = new Subject<void>();
    queue.run(() => write, { done: vi.fn(), failed: vi.fn() }, 'a');

    expect(queue.busyFor('a')).toBe(true);
    expect(queue.busyFor('b')).toBe(false);
    write.complete();
    expect(queue.busyFor('a')).toBe(false);
  });

  it('a write with nothing to send is skipped', () => {
    const { queue } = setup();
    const started = vi.fn();
    queue.run(() => null, { done: vi.fn(), failed: vi.fn(), started });

    expect(started).not.toHaveBeenCalled();
    expect(queue.busy()).toBe(false);
  });

  it('gives a failed write to its handler and goes on with the next', () => {
    const { queue, errors } = setup();
    const failed = vi.fn();
    const done = vi.fn();
    queue.run(() => throwError(() => new Error('http')), {
      done: vi.fn(),
      failed,
    });
    queue.run(() => of(1), { done, failed: vi.fn() });

    expect(failed).toHaveBeenCalledWith(new Error('http'));
    expect(done).toHaveBeenCalledWith(1);
    expect(errors.seen).toEqual([]);
  });

  it('reports what its outcome throws to the ErrorHandler and goes on', () => {
    const { queue, errors } = setup();
    const bug = new Error('bug in done');
    const done = vi.fn();
    queue.run(() => of(1), {
      done: () => {
        throw bug;
      },
      failed: vi.fn(),
    });
    queue.run(() => of(2), { done, failed: vi.fn() });

    expect(errors.seen).toEqual([bug]);
    expect(done).toHaveBeenCalledWith(2);
    expect(queue.busy()).toBe(false);
  });

  it('stops when its injector is destroyed', () => {
    const { queue } = setup();
    const write = new Subject<number>();
    const done = vi.fn();
    queue.run(() => write, { done, failed: vi.fn() });

    TestBed.resetTestingModule();
    write.next(1);

    expect(done).not.toHaveBeenCalled();
  });
});
