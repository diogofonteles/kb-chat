import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
  signal,
} from '@angular/core';
import type { RefusedDocument } from '@kb-chat/contracts';
import { UiButton } from '@ui/index.js';

let nextId = 0;

/**
 * What kb refused, for the person who decides (KBC-009): what was read of it and, for masters,
 * putting it in the collection all the same or leaving it out.
 */
@Component({
  selector: 'app-refused-review',
  imports: [UiButton],
  template: `
    <button
      uiButton="outline"
      size="sm"
      type="button"
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="id"
      (click)="open.set(!open())"
    >
      @if (open()) {
        <span i18n="@@refused.hide">Esconder o que foi lido</span>
      } @else {
        <span i18n="@@refused.show">Ver o que foi lido</span>
      }
    </button>
    @if (open()) {
      <div class="panel" [id]="id">
        <pre
          class="text"
          tabindex="0"
          role="region"
          aria-label="O que foi lido"
          i18n-aria-label="@@refused.text"
          >{{ refused().excerpt || nothing }}</pre>
        @if (refused().acceptable) {
          <div class="decide">
            <button
              uiButton="primary"
              size="sm"
              type="button"
              [disabled]="disabled()"
              (click)="accepted.emit()"
            >
              <span i18n="@@refused.accept">Incluir mesmo assim</span>
            </button>
            <button
              uiButton="ghost"
              size="sm"
              type="button"
              [disabled]="disabled()"
              (click)="discarded.emit()"
            >
              <span i18n="@@refused.discard">Deixar de fora</span>
            </button>
          </div>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--space-2);
      justify-items: start;
    }

    button {
      min-height: 2.75rem;
    }

    .panel {
      display: grid;
      gap: var(--space-3);
      width: 100%;
    }

    .text {
      max-height: 14rem;
      margin: 0;
      padding: var(--space-3);
      overflow: auto;
      border-radius: var(--radius-menu);
      background: var(--overlay-2);
      color: var(--color-text);
      font-family: inherit;
      font-size: var(--text-sm);
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    .decide {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RefusedReview {
  readonly refused = input.required<RefusedDocument>();
  readonly disabled = input(false);
  readonly accepted = output();
  readonly discarded = output();

  protected readonly id = `refused-review-${nextId++}`;
  protected readonly open = signal(false);
  protected readonly nothing = $localize`:@@refused.nothing:(nenhum texto)`;
}
