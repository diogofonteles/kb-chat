import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { UiIcon } from './icon.js';
import type { IconName } from './icons.js';

/**
 * A v2 choice card (v2 · Componentes › Cartão de escolha): icon, title and a line of help,
 * green border when chosen. Put it inside a `<label>` with a radio, or a button with
 * aria-pressed; `chosen` only draws.
 */
@Component({
  selector: 'ui-choice-card',
  imports: [UiIcon],
  template: `
    @if (icon(); as name) {
      <ui-icon class="ui-choice__icon" [name]="name" [size]="22" />
    }
    <span class="ui-choice__title">{{ title() }}</span>
    @if (help()) {
      <span class="ui-choice__help">{{ help() }}</span>
    }
    <ng-content />
  `,
  host: { class: 'ui-choice', '[class.ui-choice--chosen]': 'chosen()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiChoiceCard {
  readonly title = input.required<string>();
  readonly help = input('');
  readonly icon = input<IconName | null>(null);
  readonly chosen = input(false);
}
