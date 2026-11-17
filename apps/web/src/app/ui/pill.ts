import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type Tone = 'muted' | 'ok' | 'warn' | 'err' | 'info';

/**
 * A v2 status pill (v2 · Componentes › Pill): a short word in a tone. The word carries the
 * meaning, the colour only backs it (never colour alone).
 */
@Component({
  selector: 'ui-pill',
  template: `<ng-content />`,
  host: { class: 'ui-pill', '[attr.data-tone]': 'tone()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiPill {
  readonly tone = input<Tone>('muted');
}
