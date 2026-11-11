import {
  DestroyRef,
  ErrorHandler,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  EMPTY,
  Subject,
  catchError,
  concatMap,
  defer,
  finalize,
  ignoreElements,
  tap,
  type Observable,
} from 'rxjs';

/** What a write does with its answer. */
export interface WriteOutcome<T> {
  /** The write leaves the queue and goes out. */
  readonly started?: () => void;
  readonly done: (value: T) => void;
  /** The write itself failed (an HTTP error); its handler tells the person. */
  readonly failed: (err: unknown) => void;
}

/**
 * The writes of "Pessoas e permissões", one at a time and in the order they were made
 * (KBC-062 FR-1). Each write is built only when it leaves the queue, so it starts from what
 * the writes before it left on the server. Create it in an injection context.
 */
export class WriteQueue {
  private readonly errorHandler = inject(ErrorHandler);
  /** Writes waiting or on their way, by key ('' when the write has none). */
  private readonly waiting = signal<ReadonlyMap<string, number>>(new Map());
  private readonly queue = new Subject<Observable<never>>();

  readonly busy = computed(() => this.waiting().size > 0);

  constructor() {
    this.queue
      .pipe(
        concatMap((step) => step),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe();
  }

  busyFor(key: string): boolean {
    return this.waiting().has(key);
  }

  /** `call` runs when the write leaves the queue; null means nothing is left to send. */
  run<T>(
    call: () => Observable<T> | null,
    outcome: WriteOutcome<T>,
    key = '',
  ): void {
    const step = defer(() => {
      const request = call();
      if (!request) return EMPTY;
      outcome.started?.();
      return request.pipe(
        catchError((err: unknown) => {
          outcome.failed(err);
          return EMPTY;
        }),
        tap((value) => outcome.done(value)),
      );
    }).pipe(
      ignoreElements(),
      // A bug in an outcome is not the write failing: it is reported, the queue goes on.
      catchError((err: unknown) => {
        this.errorHandler.handleError(err);
        return EMPTY;
      }),
      finalize(() => this.count(key, -1)),
    );
    this.count(key, 1);
    this.queue.next(step);
  }

  private count(key: string, by: number): void {
    this.waiting.update((current) => {
      const next = new Map(current);
      const count = (next.get(key) ?? 0) + by;
      if (count > 0) next.set(key, count);
      else next.delete(key);
      return next;
    });
  }
}
