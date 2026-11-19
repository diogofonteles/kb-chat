import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { UiIcon } from './icon.js';

/** The Nova Alexandria mark: the green circle with the sparkle (decorative). */
@Component({
  selector: 'ui-logo',
  imports: [UiIcon],
  template: `<ui-icon name="sparkleFill" [size]="size() / 2" />`,
  host: {
    class: 'ui-logo',
    'aria-hidden': 'true',
    '[style.--ui-logo-size.px]': 'size()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiLogo {
  readonly size = input(28);
}
