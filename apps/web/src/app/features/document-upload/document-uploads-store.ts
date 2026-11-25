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
  type DocumentUploadList,
  type DocumentWork,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { DocumentUploadsApi } from '@core/documents/document-uploads-api.js';
import { MEDIA_POLL_MS } from '@features/media/media-polling.js';
import {
  EMPTY,
  Subject,
  asyncScheduler,
  catchError,
  exhaustMap,
  filter,
  finalize,
  merge,
  switchMap,
  throttleTime,
  timer,
  type Observable,
} from 'rxjs';
import { isSettled } from './upload-labels.js';

/** A folder sends many at once: the list is read at most this often, and once at the end. */
export const REFRESH_MS = 1_500;

/** Another tab, or another person, did something about it first. */
function problemOf(err: unknown): string {
  const code = toUiErrorCode(err);
  return code === 'NOT_FOUND' || code === 'MEDIA_CONFLICT'
    ? $localize`:@@docUploads.changed:Este item mudou enquanto isso. A lista foi atualizada.`
    : errorMessage(code);
}

/** Up to this many items the list is read at every beat. */
const ITEMS_PER_BEAT = 300;

/** What `busyId` says while the ready ones are cleared. */
const CLEARING = 'clear-ready';

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
  private readonly macReading = signal<DocumentWork | null>(null);
  private readonly readAt = signal(Date.now());
  private readonly read = signal(false);
  private readonly lost = signal(false);
  private readonly acting = signal<string | null>(null);
  private readonly problem = signal('');

  readonly items = this.reading.asReadonly();
  /** The Mac, as the last reading said it; null when it was not said. */
  readonly work = this.macReading.asReadonly();
  /** When the last reading came: "há 1 min" is measured to it. */
  readonly now = this.readAt.asReadonly();
  readonly failed = this.lost.asReadonly();
  /** The item a press is on: one at a time (PD-02). */
  readonly busyId = this.acting.asReadonly();
  readonly actionError = this.problem.asReadonly();
  private readonly moving = computed(
    () =>
      !this.read() ||
      this.lost() ||
      this.items().some((one) => !isSettled(one)),
  );

  /** A list of thousands is large, and takes days: it is read less often. */
  private readonly everyBeats = computed(() =>
    Math.max(1, Math.ceil(this.items().length / ITEMS_PER_BEAT)),
  );

  constructor() {
    const beats = timer(0, this.pollMs).pipe(
      filter((beat) => this.moving() && beat % this.everyBeats() === 0),
    );
    merge(
      beats.pipe(exhaustMap(() => this.list())),
      this.asked.pipe(
        throttleTime(REFRESH_MS, asyncScheduler, {
          leading: true,
          trailing: true,
        }),
        switchMap(() => this.list()),
      ),
    )
      .pipe(takeUntilDestroyed())
      .subscribe(({ items, work }) => {
        this.reading.set(items);
        this.macReading.set(work);
        this.readAt.set(Date.now());
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

  /** The recordings of a list that enter: each becomes an item of its own. */
  choose(upload: DocumentUpload, urls: readonly string[]): void {
    this.act(upload.id, this.api.choose(upload.id, urls));
  }

  /** A failed item goes again as it was sent. */
  retry(upload: DocumentUpload): void {
    this.act(upload.id, this.api.retry(upload.id));
  }

  /** What kb refused enters all the same (masters). */
  accept(upload: DocumentUpload): void {
    this.act(upload.id, this.api.accept(upload.id));
  }

  /** These, seen ready, leave the list. */
  clearReady(ids: readonly string[]): void {
    this.act(CLEARING, this.api.clearReady(ids));
  }

  private list(): Observable<DocumentUploadList> {
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
          this.problem.set(problemOf(err));
          this.refresh();
        },
      });
  }
}
