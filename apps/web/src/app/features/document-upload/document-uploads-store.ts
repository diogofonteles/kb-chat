import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  DOCUMENT_BATCH_MAX_USD,
  type DocumentUpload,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { DocumentUploadsApi } from '@core/documents/document-uploads-api.js';
import { MEDIA_POLL_MS } from '@features/media/media-polling.js';
import {
  EMPTY,
  Subject,
  catchError,
  concatMap,
  exhaustMap,
  filter,
  finalize,
  merge,
  timer,
  type Observable,
} from 'rxjs';
import { isSettled } from './upload-labels.js';

/** How much more one press of "Aumentar o teto" gives an inclusion. */
export const RAISE_STEP_USD = 0.5;

/**
 * The sent documents of "Fila de processamento" and of "Adicionar conteúdo" (KBC-149,
 * KBC-184), provided by the page: read once, then again while anything is on its way (nothing
 * is asked once all are ready or failed) and after each change made here. A failed read keeps
 * the last answer on screen and is tried again on the next beat.
 */
@Injectable()
export class DocumentUploadsStore {
  private readonly api = inject(DocumentUploadsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly pollMs = inject(MEDIA_POLL_MS);
  private readonly asked = new Subject<void>();
  private readonly reading = signal<readonly DocumentUpload[]>([]);
  private readonly read = signal(false);
  private readonly lost = signal(false);
  private readonly acting = signal<string | null>(null);
  private readonly problem = signal('');

  readonly items = this.reading.asReadonly();
  readonly failed = this.lost.asReadonly();
  /** The item a press is on: one at a time (PD-02). */
  readonly busyId = this.acting.asReadonly();
  readonly actionError = this.problem.asReadonly();
  private readonly moving = computed(
    () =>
      !this.read() ||
      this.lost() ||
      this.items().some((one) => !isSettled(one.state)),
  );

  constructor() {
    const beats = timer(0, this.pollMs).pipe(filter(() => this.moving()));
    merge(
      beats.pipe(exhaustMap(() => this.list())),
      this.asked.pipe(concatMap(() => this.list())),
    )
      .pipe(takeUntilDestroyed())
      .subscribe((items) => {
        this.reading.set(items);
        this.read.set(true);
        this.lost.set(false);
      });
  }

  refresh(): void {
    this.asked.next();
  }

  /** Out of the list: cancelled if the Mac does not have it yet. */
  remove(upload: DocumentUpload): void {
    this.act(upload.id, this.api.remove(upload.id));
  }

  /** More room for the inclusion it waits in: what waited goes on. */
  raise(upload: DocumentUpload): void {
    const { batch } = upload;
    if (!batch) return;
    const capUsd = Math.min(
      batch.capUsd + RAISE_STEP_USD,
      DOCUMENT_BATCH_MAX_USD,
    );
    this.act(upload.id, this.api.changeBatch(batch.id, capUsd));
  }

  /** A failed item goes again as it was sent. */
  retry(upload: DocumentUpload): void {
    this.act(upload.id, this.api.retry(upload.id));
  }

  private list(): Observable<DocumentUpload[]> {
    return this.api.list().pipe(
      catchError(() => {
        this.lost.set(true);
        return EMPTY;
      }),
    );
  }

  private act(id: string, work: Observable<unknown>): void {
    if (this.acting() !== null) return;
    this.acting.set(id);
    this.problem.set('');
    work
      .pipe(
        finalize(() => this.acting.set(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => this.refresh(),
        error: (err: unknown) => {
          this.problem.set(errorMessage(toUiErrorCode(err)));
          this.refresh();
        },
      });
  }
}
