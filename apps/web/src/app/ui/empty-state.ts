import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { UiIcon } from './icon.js';
import type { IconName } from './icons.js';

/**
 * A v2 empty state (v2 · Componentes › Estado vazio): an icon in a 72 circle, a 24 title,
 * a line of text and the actions (projected, pill buttons).
 */
@Component({
  selector: 'ui-empty-state',
  imports: [UiIcon],
  template: `
    <span class="ui-empty__icon"><ui-icon [name]="icon()" [size]="32" /></span>
    <p class="ui-empty__title">{{ title() }}</p>
    @if (text()) {
      <p class="ui-empty__text">{{ text() }}</p>
    }
    <div class="ui-empty__actions"><ng-content /></div>
  `,
  host: { class: 'ui-empty' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiEmptyState {
  readonly icon = input<IconName>('search');
  readonly title = input.required<string>();
  readonly text = input('');
}
