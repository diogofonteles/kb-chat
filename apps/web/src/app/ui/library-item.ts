import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { UiIcon } from './icon.js';

/**
 * A row of "Sua biblioteca" (v2 · Componentes › Item da biblioteca): art (projected cover),
 * a 15/500 title and a 13 meta line, with the green pin for a pinned item. Presentational:
 * the shell puts it inside the button or link and marks the active one (aria-current).
 */
@Component({
  selector: 'ui-library-item',
  imports: [UiIcon],
  template: `
    <ng-content select="ui-cover" />
    <span class="ui-libitem__text">
      <span class="ui-libitem__title">{{ title() }}</span
      >&ngsp;<span class="ui-libitem__meta">
        @if (pinned()) {
          <ui-icon class="ui-libitem__pin" name="pin" [size]="12" />
        }
        <ng-content select="[uiLibraryItemMeta]" />{{ meta() }}
      </span>
    </span>
    <ng-content />
  `,
  host: { class: 'ui-libitem' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiLibraryItem {
  readonly title = input.required<string>();
  readonly meta = input('');
  readonly pinned = input(false);
  /** The meta's id, for a row named by its title alone (aria-describedby). */
  readonly metaId = input<string | null>(null);
}
