import { DOCUMENT } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import type { ProcessingQueue } from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import { PreparationApi } from '@core/media/preparation-api.js';
import {
  EMPTY,
  Subject,
  catchError,
  fromEvent,
  map,
  merge,
  of,
  switchMap,
  timer,
} from 'rxjs';
import { MEDIA_POLL_MS } from '../media-polling.js';
import { queueChangeText } from './queue-labels.js';

/** The longest wait between reads while they fail. */
const MAX_RETRY_MS = 60_000;

type Reading =
  | { readonly kind: 'read'; readonly queue: ProcessingQueue }
  | { readonly kind: 'failed'; readonly error: unknown };

const isRefused = (error: unknown): boolean =>
  error instanceof HttpErrorResponse && error.status === 403;

/**
 * What is being processed (KBC-090), one reading for the sidebar's count, the library's block
 * and the queue's page. It reads while anything is at work and the tab is on screen, and
 * stops otherwise: nothing runs, nothing is asked. Coming back to the tab or the network, a
 * send and a page that needs it read once more. A newer read cancels the one on its way.
 */
@Injectable({ providedIn: 'root' })
export class ProcessingQueueStore {
  private readonly api = inject(PreparationApi);
  private readonly session = inject(SessionStore);
  private readonly document = inject(DOCUMENT);
  private readonly pollMs = inject(MEDIA_POLL_MS);
  /** The next read, after this many ms; null forgets everything. */
  private readonly next = new Subject<number | null>();

  private readonly reading = signal<ProcessingQueue | null>(null);
  private readonly lost = signal(false);
  private readonly spoken = signal('');
  private failures = 0;

  readonly allowed = computed(
    () =>
      this.session.me()?.media === true &&
      this.session.can('media') &&
      this.session.can('media-upload'),
  );
  /** The last answer: a failed read keeps it on screen. */
  readonly queue = this.reading.asReadonly();
  /** The last read failed. */
  readonly failed = this.lost.asReadonly();
  readonly items = computed(() => this.reading()?.items ?? []);
  /** The sentence for the live region: a stage that started or failed, what left. */
  readonly said = this.spoken.asReadonly();
  /** What is at work or in line. */
  readonly active = computed(() => this.reading()?.active ?? 0);

  constructor() {
    this.next
      .pipe(
        switchMap((delay) => (delay === null ? EMPTY : this.readAfter(delay))),
        takeUntilDestroyed(),
      )
      .subscribe((reading) => this.answered(reading));
    toObservable(this.allowed)
      .pipe(takeUntilDestroyed())
      .subscribe((allowed) => this.allowedChanged(allowed));
    const view = this.document.defaultView;
    merge(
      fromEvent(this.document, 'visibilitychange'),
      view ? fromEvent(view, 'online') : EMPTY,
    )
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.refresh());
  }

  /** Reads now, when the person may and the tab is on screen. */
  refresh(): void {
    if (this.allowed() && !this.hidden()) this.next.next(0);
  }

  private readAfter(delay: number) {
    return timer(delay).pipe(
      switchMap(() =>
        this.api.queue().pipe(
          map((queue): Reading => ({ kind: 'read', queue })),
          catchError((error: unknown) =>
            of<Reading>({ kind: 'failed', error }),
          ),
        ),
      ),
    );
  }

  private allowedChanged(allowed: boolean): void {
    if (allowed) {
      this.refresh();
      return;
    }
    this.next.next(null);
    this.reading.set(null);
    this.lost.set(false);
    this.failures = 0;
  }

  private answered(reading: Reading): void {
    if (reading.kind === 'failed' && isRefused(reading.error)) {
      this.allowedChanged(false);
      return;
    }
    this.lost.set(reading.kind === 'failed');
    if (reading.kind === 'read') this.take(reading.queue);
    else this.failures += 1;
    if (this.hidden()) return;
    if (this.lost()) this.next.next(this.retryMs());
    else if (this.active() > 0) this.next.next(this.pollMs);
  }

  private take(queue: ProcessingQueue): void {
    this.failures = 0;
    const before = this.reading();
    const sentence = before ? queueChangeText(before.items, queue.items) : '';
    if (sentence) this.spoken.set(sentence);
    this.reading.set(queue);
  }

  /** A read that failed comes again, each time later: the banner promises it. */
  private retryMs(): number {
    return Math.min(this.pollMs * 2 ** (this.failures - 1), MAX_RETRY_MS);
  }

  private hidden(): boolean {
    return this.document.visibilityState === 'hidden';
  }
}
