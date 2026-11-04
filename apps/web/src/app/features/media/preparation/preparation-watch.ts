import {
  DestroyRef,
  Injectable,
  InjectionToken,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import type { MediaPreparation, StageState } from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { PreparationApi } from '@core/media/preparation-api.js';
import { Subject, catchError, map, of, switchMap, timer } from 'rxjs';
import { PreparationAnnouncer } from './preparation-announcer.js';

/** While anything runs, step 2 refreshes this often (FR-5). */
export const PREPARATION_POLL_MS = new InjectionToken<number>(
  'PREPARATION_POLL_MS',
  { providedIn: 'root', factory: () => 3_000 },
);

const MOVING: ReadonlySet<StageState> = new Set([
  'waiting',
  'queued',
  'running',
]);

const isMoving = (preparation: MediaPreparation): boolean =>
  preparation.step === 2 &&
  preparation.stages.some(({ state }) => MOVING.has(state));

type Reading =
  | { readonly kind: 'read'; readonly preparation: MediaPreparation }
  | { readonly kind: 'failed'; readonly error: unknown };

const isConnectionLost = (error: unknown): boolean =>
  error instanceof HttpErrorResponse &&
  (error.status === 0 || error.status >= 502);

/**
 * Step 2 as it moves on the server (FR-5, BR-8): a read each 3 s while anything runs, none
 * once nothing does or the tab is hidden, and one on coming back. It only replaces the
 * reading, so the scroll and the focus stay where they are.
 */
@Injectable()
export class PreparationWatch {
  private readonly api = inject(PreparationApi);
  private readonly pollMs = inject(PREPARATION_POLL_MS);
  private readonly announcer = new PreparationAnnouncer();
  private readonly destroyRef = inject(DestroyRef);
  private readonly next = new Subject<number>();
  private mediaId = '';
  private known: ReadonlySet<string> | null = null;

  private readonly reading = signal<MediaPreparation | null>(null);
  private readonly lost = signal(false);
  private readonly refused = signal(false);
  private readonly failure = signal('');
  private readonly spoken = signal('');
  private readonly arrived = signal<ReadonlySet<string>>(new Set());
  private readonly notSeen = signal(0);

  readonly preparation = this.reading.asReadonly();
  /** "Sem conexão": the work goes on, the screen waits for the network. */
  readonly offline = this.lost.asReadonly();
  readonly forbidden = this.refused.asReadonly();
  readonly loadError = this.failure.asReadonly();
  /** The sentence for the live region (BR-9). */
  readonly said = this.spoken.asReadonly();
  /** The tracks that came with the last reading: they enter highlighted. */
  readonly fresh = this.arrived.asReadonly();
  /** The tracks that came since the person last saw the end of the list. */
  readonly unseen = this.notSeen.asReadonly();

  constructor() {
    this.next
      .pipe(
        switchMap((delay) => timer(delay)),
        switchMap(() =>
          this.api.read(this.mediaId).pipe(
            map((preparation): Reading => ({ kind: 'read', preparation })),
            catchError((error: unknown) =>
              of<Reading>({ kind: 'failed', error }),
            ),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((reading) => this.answered(reading));
  }

  start(mediaId: string): void {
    this.mediaId = mediaId;
    this.next.next(0);
  }

  /** An action answered with where things stand now. */
  replace(preparation: MediaPreparation): void {
    this.lost.set(false);
    this.take(preparation);
  }

  /** The tab came back, or the network did. */
  resume(): void {
    if (this.mediaId && !this.hidden()) this.next.next(0);
  }

  markSeen(): void {
    this.notSeen.set(0);
  }

  private answered(reading: Reading): void {
    if (reading.kind === 'read') return this.replace(reading.preparation);
    if (isConnectionLost(reading.error)) {
      this.lost.set(true);
      this.schedule();
    } else if (toUiErrorCode(reading.error) === 'FORBIDDEN') {
      this.refused.set(true);
    } else {
      this.failure.set(errorMessage(toUiErrorCode(reading.error)));
    }
  }

  private take(preparation: MediaPreparation): void {
    this.noteTracks(preparation);
    this.reading.set(preparation);
    const sentence = this.announcer.observe(preparation);
    if (sentence) this.spoken.set(sentence);
    if (isMoving(preparation)) this.schedule();
  }

  private noteTracks({ tracks }: MediaPreparation): void {
    const ids = new Set(tracks.map(({ id }) => id));
    const fresh = this.known
      ? new Set([...ids].filter((id) => !this.known?.has(id)))
      : new Set<string>();
    this.known = ids;
    this.arrived.set(fresh);
    if (fresh.size > 0) this.notSeen.update((count) => count + fresh.size);
  }

  private schedule(): void {
    if (!this.hidden()) this.next.next(this.pollMs);
  }

  private hidden(): boolean {
    return document.visibilityState === 'hidden';
  }
}
