import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { UiIcon } from './icon.js';
import type { IconName } from './icons.js';
import type { Tone } from './pill.js';

export type BannerTone = Exclude<Tone, 'muted'>;

const ICON_OF: Record<BannerTone, IconName> = {
  err: 'xcircle',
  warn: 'warn',
  info: 'info',
  ok: 'checkcircle',
};

/**
 * A v2 banner (v2 · Componentes › Banner): an icon in the tone, a bold title, an optional
 * line of text (the projected content) and one direct action (`[uiBannerAction]`). The
 * host takes the role the case needs (`role="alert"` for an error that just happened).
 */
@Component({
  selector: 'ui-banner',
  imports: [UiIcon],
  template: `
    <ui-icon class="ui-banner__icon" [name]="icon()" [size]="20" />
    <div class="ui-banner__body">
      @if (title()) {
        <p class="ui-banner__title">{{ title() }}</p>
      }
      <div class="ui-banner__text"><ng-content /></div>
    </div>
    <ng-content select="[uiBannerAction]" />
  `,
  host: { class: 'ui-banner', '[attr.data-tone]': 'tone()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiBanner {
  readonly tone = input<BannerTone>('info');
  readonly title = input('');
  protected readonly icon = computed(() => ICON_OF[this.tone()]);
}
