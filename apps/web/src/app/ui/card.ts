import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { UiCover } from './cover.js';
import { UiProgress } from './progress.js';

/**
 * A v2 card (v2 · Componentes › Cartão): cover, bold title and a two-line subtitle, with the
 * listening progress on the cover. Presentational: put it inside the link or button.
 */
@Component({
  selector: 'ui-card',
  imports: [UiCover, UiProgress],
  template: `
    <span class="ui-card__art">
      <ui-cover [title]="title()" [size]="size()" />
      @if (progress() !== null) {
        <ui-progress class="ui-card__progress" [value]="progress() ?? 0" />
      }
    </span>
    <span class="ui-card__title">{{ title() }}</span>
    @if (subtitle()) {
      <span class="ui-card__subtitle">{{ subtitle() }}</span>
    }
  `,
  host: { class: 'ui-card', '[style.--ui-card-size.px]': 'size()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiCard {
  readonly title = input.required<string>();
  readonly subtitle = input('');
  readonly size = input(160);
  readonly progress = input<number | null>(null);
}
