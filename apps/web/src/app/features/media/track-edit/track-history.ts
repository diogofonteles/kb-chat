import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { trackHistorySchema, type TrackChange } from '@kb-chat/contracts';
import { trackHistoryUrl } from '@core/media/track-revisions-api.js';
import { changeFieldText, changeValuesText } from './track-edit-labels.js';

/** "Histórico" of a track (KBC-073 FR-5): who, when, the field, before and after. */
@Component({
  selector: 'app-track-history',
  imports: [DatePipe],
  template: `
    @if (read.error()) {
      <p class="note" role="alert" i18n="@@trackEdit.history.failed">
        Não consegui ler o histórico.
      </p>
    } @else if (read.hasValue()) {
      @if (changes().length === 0) {
        <p class="note" i18n="@@trackEdit.history.empty">
          Nada mudou nesta faixa desde que foi aprovada.
        </p>
      } @else {
        <ol class="changes">
          @for (change of changes(); track change.id) {
            <li>
              <span class="what">{{ fieldOf(change) }}</span>
              @if (valuesOf(change); as values) {
                <span class="values">{{ values }}</span>
              }
              <span class="note">
                {{ change.by }} · {{ change.at | date: 'dd/MM/yyyy HH:mm' }}
              </span>
            </li>
          }
        </ol>
      }
    } @else {
      <p class="note" aria-busy="true" i18n="@@trackEdit.loading">
        Carregando…
      </p>
    }
  `,
  styles: `
    .changes {
      display: grid;
      gap: var(--space-3);
      margin: var(--space-2) 0 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: grid;
      gap: var(--space-1);
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .what {
      font-weight: 600;
    }
    .note {
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--text-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackHistory {
  readonly mediaId = input.required<string>();

  protected readonly read = httpResource(
    () => trackHistoryUrl(this.mediaId()),
    {
      parse: (body) => trackHistorySchema.parse(body).changes,
    },
  );
  protected readonly changes = computed(() =>
    this.read.hasValue() ? this.read.value() : [],
  );

  protected fieldOf(change: TrackChange): string {
    return changeFieldText(change.field);
  }

  protected valuesOf(change: TrackChange): string {
    return changeValuesText(change);
  }
}
