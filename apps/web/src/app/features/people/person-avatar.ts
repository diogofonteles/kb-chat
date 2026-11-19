import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

/** The v2 people palette (v2 · Pessoas): the colour of a person is fixed by their name. */
const PERSON_TONES = 9;

/** Initials as in the v2 rows: the first and last names' letters, one letter for one word. */
export function personInitials(name: string): string {
  const source = name.trim();
  if (!source) return '?';
  if (source.includes('@')) return source.charAt(0).toUpperCase();
  const words = source.split(/\s+/u);
  const first = words[0]?.charAt(0) ?? '';
  const last = words.length > 1 ? (words.at(-1)?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase();
}

/** 1..PERSON_TONES for a name, 0 for an address without a name yet (the grey of an invite). */
export function personTone(name: string): number {
  const source = name.trim().toLowerCase();
  if (!source || source.includes('@')) return 0;
  let hash = 0;
  for (const char of source) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (hash % PERSON_TONES) + 1;
}

/**
 * A person in the people lists (v2 · Pessoas): two initials on a colour of the palette fixed
 * by the name, the owner in gold with one letter, an invite without a name in grey. It keeps
 * the shared avatar's shape (`ui-avatar` class); the palette lives here until the shared
 * avatar takes it. Decorative: the name next to it says who it is.
 */
@Component({
  selector: 'app-person-avatar',
  template: `{{ initials() }}`,
  styles: `
    :host {
      --person-tone-0: #5a5a5a;
      --person-tone-1: #6b3fa0;
      --person-tone-2: #2d5a8a;
      --person-tone-3: #a64d29;
      --person-tone-4: #1f7a6b;
      --person-tone-5: #8a3a6a;
      --person-tone-6: #3f4fa0;
      --person-tone-7: #7a5a3a;
      --person-tone-8: #2f8a8a;
      --person-tone-9: #a01f4a;
      --person-tone-owner: #b8862b;
      background: var(--person-tone-0);
      color: #ffffff;
    }
    :host([data-tone='1']) {
      background: var(--person-tone-1);
    }
    :host([data-tone='2']) {
      background: var(--person-tone-2);
    }
    :host([data-tone='3']) {
      background: var(--person-tone-3);
    }
    :host([data-tone='4']) {
      background: var(--person-tone-4);
    }
    :host([data-tone='5']) {
      background: var(--person-tone-5);
    }
    :host([data-tone='6']) {
      background: var(--person-tone-6);
    }
    :host([data-tone='7']) {
      background: var(--person-tone-7);
    }
    :host([data-tone='8']) {
      background: var(--person-tone-8);
    }
    :host([data-tone='9']) {
      background: var(--person-tone-9);
    }
    :host([data-tone='owner']) {
      background: var(--person-tone-owner);
      color: #000000;
    }
  `,
  host: {
    class: 'ui-avatar',
    'aria-hidden': 'true',
    '[style.--ui-avatar-size.px]': 'size()',
    '[attr.data-tone]': 'tone()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PersonAvatar {
  readonly name = input('');
  readonly size = input(36);
  /** The owner's row shows the account's gold with one letter, as in v2. */
  readonly owner = input(false);
  protected readonly tone = computed(() =>
    this.owner() ? 'owner' : String(personTone(this.name())),
  );
  protected readonly initials = computed(() =>
    this.owner()
      ? (this.name().trim().charAt(0) || '?').toUpperCase()
      : personInitials(this.name()),
  );
}
