import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

/** How many avatar colours the tokens have (--avatar-N-bg / --avatar-N-fg). */
const AVATAR_COLORS = 6;

/** The initials of v2: the first letters of the first and the last name ("BL"), or one. */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/[\s@._-]+/)
    .filter((word) => word.length > 0);
  if (name.includes('@') || words.length < 2)
    return (name.trim().charAt(0) || '?').toUpperCase();
  return `${words[0]?.charAt(0) ?? ''}${words.at(-1)?.charAt(0) ?? ''}`.toUpperCase();
}

/** The same name, the same colour, on every screen. */
export function avatarColorOf(name: string): number {
  let hash = 7;
  for (const char of name)
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash % AVATAR_COLORS;
}

/**
 * A person's avatar: the Google picture, or the initials on a colour of their own.
 * Decorative: the name next to it (or the button around it) says who it is.
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
    '[style.--ui-avatar-bg]': '"var(--avatar-" + color() + "-bg)"',
    '[style.--ui-avatar-fg]': '"var(--avatar-" + color() + "-fg)"',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiAvatar {
  readonly name = input('');
  readonly picture = input<string | null | undefined>(null);
  readonly size = input(32);
  protected readonly initial = computed(() => initialsOf(this.name()));
  protected readonly color = computed(() => avatarColorOf(this.name().trim()));
}
