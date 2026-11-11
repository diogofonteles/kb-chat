import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { levelChoicesSchema, type ContentLevel } from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { LevelsApi, levelChoicesUrl } from '@core/levels/levels-api.js';
import { finalize } from 'rxjs';

/**
 * The document's level in the reading panel (T3, KBC-103): the badge "Nível: CI" or "Sem
 * nível", and "Mudar nível". Only shown when the API sent a level, which it does for whoever
 * manages levels in a collection with a scale; members never see it.
 */
@Component({
  selector: 'app-document-level',
  template: `
    <div class="level">
      @if (current(); as level) {
        <span class="badge" i18n="@@docLevel.badge"
          >Nível: {{ level.code }}</span
        >
      } @else {
        <span class="badge unassigned" i18n="@@docLevel.none"
          ><span aria-hidden="true">⚠</span> Sem nível</span
        >
      }
      @if (!changing()) {
        <button
          type="button"
          class="link"
          (click)="changing.set(true)"
          i18n="@@docLevel.change"
        >
          Mudar nível
        </button>
      } @else {
        <form class="change" (submit)="$event.preventDefault(); save()">
          <label class="field">
            <span i18n="@@docLevel.label">Nível</span>
            <select
              #levelSelect
              [disabled]="!scale.hasValue() || busy()"
              (change)="chosen.set(levelSelect.value)"
            >
              @if (current() === null) {
                <option
                  value=""
                  [selected]="chosen() === ''"
                  disabled
                  i18n="@@docLevel.choose"
                >
                  Escolha
                </option>
              }
              @for (level of choices(); track level.id) {
                <option [value]="level.id" [selected]="level.id === chosen()">
                  {{ level.code }}
                </option>
              }
            </select>
          </label>
          <button
            type="submit"
            class="primary"
            [disabled]="busy() || !chosen()"
            i18n="@@docLevel.save"
          >
            Salvar
          </button>
          <button
            type="button"
            class="link"
            (click)="changing.set(false)"
            i18n="@@docLevel.cancel"
          >
            Cancelar
          </button>
        </form>
      }
      @if (failure(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
      <p class="visually-hidden" aria-live="polite">{{ announcement() }}</p>
    </div>
  `,
  styles: `
    .level {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
    }
    .badge {
      padding: var(--space-1) var(--space-2);
      border: 1px solid var(--color-accent-strong);
      border-radius: 999px;
      color: var(--color-accent-strong);
      font-size: var(--text-sm);
      font-weight: 600;
    }
    .unassigned {
      border-color: var(--color-danger);
      color: var(--color-danger);
    }
    .change {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: flex-end;
    }
    .field {
      display: grid;
      gap: var(--space-1);
      font-size: var(--text-sm);
      font-weight: 600;
    }
    select,
    button {
      min-height: var(--target);
      font: inherit;
    }
    select {
      padding: 0 var(--space-2);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-bg);
      color: var(--color-text);
    }
    .primary {
      padding: 0 var(--space-4);
      border: none;
      border-radius: var(--radius-sm);
      background: var(--color-accent);
      color: var(--color-on-accent);
      font-weight: 600;
    }
    .link {
      padding: 0 var(--space-2);
      border: none;
      background: none;
      color: var(--color-accent-strong);
      font-weight: 600;
      text-decoration: underline;
      cursor: pointer;
    }
    .error {
      flex-basis: 100%;
      margin: 0;
      color: var(--color-danger);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DocumentLevel {
  private readonly api = inject(LevelsApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly topic = input.required<string>();
  readonly documentId = input.required<string>();
  /** What the API sent: the level, or null for "Sem nível". */
  readonly level = input.required<ContentLevel>();

  /** The level after a save, over what the document came with. */
  protected readonly current = linkedSignal(() => this.level());
  protected readonly changing = signal(false);
  protected readonly busy = signal(false);
  protected readonly failure = signal('');
  protected readonly announcement = signal('');
  /**
   * The levels the person may give, asked for only once "Mudar nível" is open: up to their
   * own for whoever classifies content (KBC-107 AC-4), every one for masters.
   */
  protected readonly scale = httpResource(
    () => (this.changing() ? levelChoicesUrl(this.topic()) : undefined),
    { parse: (body) => levelChoicesSchema.parse(body) },
  );
  protected readonly choices = computed(() =>
    this.scale.hasValue() ? this.scale.value().levels : [],
  );
  protected readonly chosen = linkedSignal(() => this.current()?.id ?? '');

  protected save(): void {
    const level = this.chosen();
    if (!level || this.busy()) return;
    this.busy.set(true);
    this.failure.set('');
    this.api
      .setDocumentLevel({ topic: this.topic(), id: this.documentId() }, level)
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (saved) => {
          this.current.set(saved);
          this.changing.set(false);
          this.announcement.set(
            $localize`:@@docLevel.saved:Nível salvo: ${saved?.code ?? ''}:code:.`,
          );
        },
        error: (err: unknown) =>
          this.failure.set(errorMessage(toUiErrorCode(err))),
      });
  }
}
