import { Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { DocumentUpload } from '@kb-chat/contracts';
import { DocumentUploadsApi } from '@core/documents/document-uploads-api.js';
import { MEDIA_POLL_MS } from '@features/media/media-polling.js';
import { EMPTY, catchError, exhaustMap, filter, timer } from 'rxjs';
import { isSettled } from './upload-labels.js';

/**
 * The sent documents of "Fila de processamento" (KBC-149), provided by the page: read once,
 * then again while anything is on its way (nothing is asked once all are ready or failed).
 * A failed read keeps the last answer on screen and is tried again on the next beat.
 */
@Injectable()
export class DocumentUploadsStore {
  private readonly api = inject(DocumentUploadsApi);
  private readonly pollMs = inject(MEDIA_POLL_MS);
  private readonly reading = signal<readonly DocumentUpload[]>([]);
  private readonly read = signal(false);
  private readonly lost = signal(false);

  readonly items = this.reading.asReadonly();
  readonly failed = this.lost.asReadonly();
  private readonly moving = computed(
    () =>
      !this.read() ||
      this.lost() ||
      this.items().some((one) => !isSettled(one.state)),
  );

  constructor() {
    timer(0, this.pollMs)
      .pipe(
        filter(() => this.moving()),
        exhaustMap(() =>
          this.api.list().pipe(
            catchError(() => {
              this.lost.set(true);
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((items) => {
        this.reading.set(items);
        this.read.set(true);
        this.lost.set(false);
      });
  }
}
