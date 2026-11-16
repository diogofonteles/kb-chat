import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { ICONS, type IconName, type IconShape } from './icons.js';

/**
 * A v2 icon (KBC-124): decorative by default (aria-hidden), in the text colour, so the
 * control around it carries the name. Size in px (16, 18, 20, 24…).
 */
@Component({
  selector: 'ui-icon',
  template: `
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      [attr.width]="size()"
      [attr.height]="size()"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      @for (shape of shapes(); track $index) {
        @switch (shape.t) {
          @case ('circle') {
            <circle
              [attr.cx]="shape.cx"
              [attr.cy]="shape.cy"
              [attr.r]="shape.r"
              [attr.fill]="shape.fill ? 'currentColor' : null"
              [attr.stroke]="shape.fill ? 'none' : null"
            />
          }
          @case ('rect') {
            <rect
              [attr.x]="shape.x"
              [attr.y]="shape.y"
              [attr.width]="shape.width"
              [attr.height]="shape.height"
              [attr.rx]="shape.rx"
              [attr.fill]="shape.fill ? 'currentColor' : null"
              [attr.stroke]="shape.fill ? 'none' : null"
            />
          }
          @default {
            <path
              [attr.d]="shape.d"
              [attr.fill]="shape.fill ? 'currentColor' : null"
              [attr.stroke]="shape.fill ? 'none' : null"
            />
          }
        }
      }
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
      line-height: 0;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiIcon {
  readonly name = input.required<IconName>();
  readonly size = input(20);
  protected readonly shapes = computed(
    (): readonly IconShape[] => ICONS[this.name()],
  );
}
