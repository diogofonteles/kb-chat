import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { trackImpactSchema } from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import {
  TrackRevisionsApi,
  trackImpactUrl,
} from '@core/media/track-revisions-api.js';
import { impactText } from './track-edit-labels.js';

/** "Apagar faixa" (KBC-073 FR-4): the impact first, and the way back said (BR-7). */
@Component({
  selector: 'app-track-delete-dialog',
  template: `
    <dialog
      #dialog
      class="dialog"
      aria-labelledby="delete-track-title"
      (close)="closed.emit()"
    >
      <h2 id="delete-track-title" i18n="@@trackEdit.delete.title">
        Apagar “{{ title() }}”?
      </h2>
      @if (impact(); as text) {
        <p>{{ text }}</p>
      } @else {
        <p class="note" aria-busy="true" i18n="@@trackEdit.loading">
          Carregando…
        </p>
      }
      @if (failure(); as text) {
        <p class="error" role="alert">{{ text }}</p>
      }
      <div class="line-actions">
        <button
          type="button"
          class="secondary"
          (click)="cancel()"
          i18n="@@trackEdit.cancel"
        >
          Cancelar
        </button>
        <button
          type="button"
          class="danger"
          [disabled]="busy() || impact() === null"
          (click)="confirm()"
          i18n="@@trackEdit.delete"
        >
          Apagar faixa
        </button>
      </div>
    </dialog>
  `,
  styleUrl: './track-edit.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackDeleteDialog {
  private readonly api = inject(TrackRevisionsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly mediaId = input.required<string>();
  readonly title = input.required<string>();
  readonly deleted = output();
  readonly closed = output();

  private readonly read = httpResource(() => trackImpactUrl(this.mediaId()), {
    parse: (body) => trackImpactSchema.parse(body),
  });
  protected readonly impact = computed(() =>
    this.read.hasValue() ? impactText(this.read.value()) : null,
  );
  protected readonly busy = signal(false);
  protected readonly failure = signal('');

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
  }

  protected cancel(): void {
    this.dialog().nativeElement.close();
  }

  protected confirm(): void {
    this.busy.set(true);
    this.failure.set('');
    this.api
      .remove(this.mediaId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.deleted.emit(),
        error: (err: unknown) => {
          this.busy.set(false);
          this.failure.set(errorMessage(toUiErrorCode(err)));
        },
      });
  }
}
