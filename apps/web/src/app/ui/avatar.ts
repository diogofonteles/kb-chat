import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

/**
 * A person's avatar: the Google picture, or the initial on a colour of its own. Decorative:
 * the name next to it (or the button around it) says who it is.
 */
@Component({
  selector: 'ui-avatar',
  template: `
    @if (picture()) {
      <img
        [src]="picture()"
        alt=""
        [attr.width]="size()"
        [attr.height]="size()"
        referrerpolicy="no-referrer"
      />
    } @else {
      {{ initial() }}
    }
  `,
  host: {
    class: 'ui-avatar',
    'aria-hidden': 'true',
    '[style.--ui-avatar-size.px]': 'size()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiAvatar {
  readonly name = input('');
  readonly picture = input<string | null | undefined>(null);
  readonly size = input(32);
  protected readonly initial = computed(() =>
    (this.name().trim().charAt(0) || '?').toUpperCase(),
  );
}
