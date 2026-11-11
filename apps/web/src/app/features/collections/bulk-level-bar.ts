import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { LevelChoice } from '@kb-chat/contracts';

/**
 * "N selecionados · Nível: [ ] · Dar nível" (T24, KBC-107 FR-6): the level for a selection,
 * with no level chosen in advance (SL-28) and a confirmation in the bar that says how many
 * documents go where (MA-27). On the phone it stays at the bottom of the screen (UP-13).
 */
@Component({
  selector: 'app-bulk-level-bar',
  template: `
    <div class="bar" role="group" [attr.aria-label]="groupLabel()">
      <p class="count" aria-live="polite">{{ countText() }}</p>
      @if (confirming()) {
        <p class="confirm">{{ confirmText() }}</p>
        <div class="actions">
          <button
            #confirmButton
            type="button"
            class="primary"
            [disabled]="busy()"
            [attr.aria-busy]="busy()"
            (click)="confirm()"
            i18n="@@bulkLevel.confirm"
          >
            Confirmar
          </button>
          <button
            type="button"
            class="link"
            [disabled]="busy()"
            (click)="cancel()"
            i18n="@@bulkLevel.cancel"
          >
            Cancelar
          </button>
        </div>
      } @else {
        <label class="field">
          <span i18n="@@bulkLevel.level">Nível</span>
          <select
            #levelSelect
            [disabled]="busy()"
            (change)="chosen.set(levelSelect.value)"
          >
            <option
              value=""
              disabled
              [selected]="chosen() === ''"
              i18n="@@bulkLevel.choose"
            >
              Escolha
            </option>
            @for (level of choices(); track level.id) {
              <option [value]="level.id" [selected]="level.id === chosen()">
                {{ level.code }}
              </option>
            }
          </select>
        </label>
        <button
          #applyButton
          type="button"
          class="primary"
          [disabled]="busy() || count() === 0 || !chosen()"
          (click)="ask()"
        >
          {{ actionLabel() }}
        </button>
      }
      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .bar {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: flex-end;
      padding: var(--space-3);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface);
    }
    .count,
    .confirm,
    .error {
      flex-basis: 100%;
      margin: 0;
      overflow-wrap: anywhere;
    }
    .count {
      font-weight: 600;
    }
    .error {
      color: var(--color-danger);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
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
      min-width: 8rem;
      padding: 0 var(--space-2);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-bg);
      color: var(--color-text);
    }
    button {
      padding: 0 var(--space-4);
      border-radius: var(--radius-sm);
      font-weight: 600;
      cursor: pointer;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }
    .primary {
      border: none;
      background: var(--color-accent);
      color: var(--color-on-accent);
    }
    .link {
      border: none;
      background: none;
      color: var(--color-accent-strong);
      text-decoration: underline;
    }
    @media (max-width: 767px) {
      :host {
        position: sticky;
        bottom: 0;
        z-index: 1;
      }
      .bar {
        border-radius: var(--radius-md) var(--radius-md) 0 0;
        box-shadow: 0 -2px 8px rgb(0 0 0 / 15%);
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BulkLevelBar {
  private readonly injector = inject(Injector);
  private readonly confirmButton =
    viewChild<ElementRef<HTMLButtonElement>>('confirmButton');
  private readonly applyButton =
    viewChild<ElementRef<HTMLButtonElement>>('applyButton');

  /** How many documents the level would go to. */
  readonly count = input.required<number>();
  /** The levels the person may give: up to their own. */
  readonly choices = input.required<readonly LevelChoice[]>();
  readonly busy = input(false);
  readonly error = input('');
  /** "Dar nível" for the queue, "Mudar nível" for documents that have one. */
  readonly actionLabel = input($localize`:@@bulkLevel.give:Dar nível`);
  /** The level chosen and confirmed. */
  readonly applied = output<LevelChoice>();

  /** No level in advance (SL-28); emptied when the choices change. */
  protected readonly chosen = linkedSignal<readonly LevelChoice[], string>({
    source: () => this.choices(),
    computation: () => '',
  });
  protected readonly confirming = signal(false);
  private readonly chosenLevel = computed(() =>
    this.choices().find((one) => one.id === this.chosen()),
  );

  protected readonly groupLabel = computed(
    () => $localize`:@@bulkLevel.group:Nível em lote`,
  );
  protected readonly countText = computed(() => {
    const count = this.count();
    return count === 1
      ? $localize`:@@bulkLevel.oneSelected:1 selecionado`
      : $localize`:@@bulkLevel.selected:${count}:count: selecionados`;
  });
  protected readonly confirmText = computed(() => {
    const code = this.chosenLevel()?.code ?? '';
    const count = this.count();
    return count === 1
      ? $localize`:@@bulkLevel.confirmOne:Dar o nível ${code}:code: a 1 documento?`
      : $localize`:@@bulkLevel.confirmMany:Dar o nível ${code}:code: a ${count}:count: documentos?`;
  });

  protected ask(): void {
    if (!this.chosenLevel() || this.count() === 0) return;
    this.confirming.set(true);
    this.focusAfterRender(() => this.confirmButton());
  }

  protected confirm(): void {
    const level = this.chosenLevel();
    if (!level || this.busy()) return;
    this.confirming.set(false);
    this.applied.emit(level);
    this.focusAfterRender(() => this.applyButton());
  }

  protected cancel(): void {
    this.confirming.set(false);
    this.focusAfterRender(() => this.applyButton());
  }

  private focusAfterRender(
    target: () => ElementRef<HTMLElement> | undefined,
  ): void {
    afterNextRender(() => target()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }
}
