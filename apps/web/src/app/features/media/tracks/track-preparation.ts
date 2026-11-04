import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { mediaEditSchema } from '@kb-chat/contracts';
import { interval } from 'rxjs';
import { MediaEditApi, mediaEditUrl } from '@core/media/media-edit-api.js';
import { MEDIA_POLL_MS } from '../media-polling.js';

/**
 * "Preparando faixas: 3 de 12" (KBC-068 FR-1): for whoever edits, between the approval and the
 * moment listeners get every track. Polls only while a cut is on its way.
 */
@Component({
  selector: 'app-track-preparation',
  template: `
    <p class="status" role="status">
      @if (preparation(); as now) {
        @if (now.failed > 0) {
          <span>{{ failedText() }}</span>
          <button
            type="button"
            class="secondary"
            [disabled]="retrying()"
            (click)="retry()"
            i18n="@@tracks.preparing.retry"
          >
            Tentar de novo
          </button>
        } @else {
          <span>{{ progressText() }}</span>
        }
      } @else if (finished()) {
        <span>{{ doneText() }}</span>
      }
    </p>
  `,
  styles: `
    .status {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      margin: 0;
    }
    .status:empty {
      display: none;
    }
    .secondary {
      min-height: 2.75rem;
      padding: var(--space-1) var(--space-3);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: transparent;
      color: inherit;
      cursor: pointer;
    }
    .secondary:focus-visible {
      outline: 2px solid var(--color-accent);
      outline-offset: 2px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackPreparationStatus {
  readonly mediaId = input.required<string>();

  private readonly api = inject(MediaEditApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly edit = httpResource(() => mediaEditUrl(this.mediaId()), {
    parse: (body) => mediaEditSchema.parse(body),
  });

  /** The last count read: a failed poll keeps it on the screen. */
  private readonly known = computed(() =>
    this.edit.hasValue() ? this.edit.value() : null,
  );
  protected readonly preparation = computed(
    () => this.known()?.preparation ?? null,
  );
  /** Seen working in this visit: only then "prontas" is news. */
  private readonly total = signal(0);
  protected readonly finished = computed(
    () => this.total() > 0 && this.preparation() === null,
  );
  protected readonly retrying = signal(false);

  protected readonly progressText = computed(() => {
    const now = this.preparation();
    return $localize`:@@tracks.preparing:Preparando faixas: ${now?.done ?? 0}:done: de ${now?.total ?? 0}:total:`;
  });
  protected readonly failedText = computed(() => {
    const failed = this.preparation()?.failed ?? 0;
    return failed === 1
      ? $localize`:@@tracks.preparing.failedOne:Não foi possível preparar 1 faixa`
      : $localize`:@@tracks.preparing.failed:Não foi possível preparar ${failed}:count: faixas`;
  });
  protected readonly doneText = computed(() => {
    const total = this.total();
    return total === 1
      ? $localize`:@@tracks.preparing.doneOne:1 faixa pronta`
      : $localize`:@@tracks.preparing.done:${total}:count: faixas prontas`;
  });

  constructor() {
    interval(inject(MEDIA_POLL_MS))
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.poll());
  }

  private poll(): void {
    const now = this.preparation();
    if (now) this.total.set(now.total);
    if (now && now.failed === 0) this.edit.reload();
  }

  protected retry(): void {
    const edit = this.known();
    if (!edit) return;
    this.retrying.set(true);
    this.api
      .retryCuts(edit.mediaId, edit.version)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.retrying.set(false);
          this.edit.reload();
        },
        error: () => {
          this.retrying.set(false);
          this.edit.reload();
        },
      });
  }
}
