import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { UiIcon } from './icon.js';
import type { IconName } from './icons.js';

/** The cover gradients of the v2 fixtures (lib.js, COVERS): [light, dark]. */
const GRADIENTS: readonly (readonly [string, string])[] = [
  ['#a64d29', '#3a1a10'],
  ['#2d5a8a', '#0f1f33'],
  ['#6b3fa0', '#1d1033'],
  ['#b8862b', '#3d2a0a'],
  ['#1f7a6b', '#082621'],
  ['#a01f4a', '#2d0814'],
  ['#3f4fa0', '#101533'],
  ['#8a8a2a', '#26260a'],
  ['#c0562f', '#401608'],
  ['#4a3fa0', '#14102e'],
  ['#1f9c56', '#0b3d22'],
  ['#7a5a3a', '#241a10'],
  ['#2f8a8a', '#0b2a2a'],
  ['#8a3a6a', '#2a0b20'],
  ['#3a7a2f', '#0f240b'],
  ['#2f4f8a', '#0b1424'],
];
const FALLBACK: readonly [string, string] = ['#5a5a5a', '#1a1a1a'];
/** Short words that never make a cover's code ("A Lei do Ritmo" → LE). */
const SKIPPED = new Set([
  'a',
  'o',
  'as',
  'os',
  'de',
  'da',
  'do',
  'das',
  'dos',
  'e',
  'the',
]);

/**
 * A title's code, as the v2 frames draw it: the first two letters of its first word
 * ("Alquimia Prática" → AL, "Cosmologia Espiritual" → CO, "Hermetismo" → HE), short words
 * skipped ("A Lei do Ritmo" → LE).
 */
export function coverCode(title: string): string {
  const [first = ''] = title
    .split(/[\s/·—-]+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((word) => word && !SKIPPED.has(word.toLowerCase()));
  return first ? first.slice(0, 2).toUpperCase() : '?';
}

/** The same title always gets the same gradient. */
export function coverGradient(seed: string): readonly [string, string] {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return GRADIENTS[hash % GRADIENTS.length] ?? FALLBACK;
}

/**
 * A v2 typographic cover (v2 · Componentes › Capa): the initials (or an icon) over a gradient
 * of the item's own colour, and from 120 px the title in capitals at the foot. Decorative:
 * the title is always written next to it.
 */
@Component({
  selector: 'ui-cover',
  imports: [UiIcon],
  template: `
    @if (icon(); as name) {
      <ui-icon [name]="name" [size]="iconSize()" />
    } @else {
      <span class="ui-cover__code">{{ code() }}</span>
      @if (showLabel()) {
        <span class="ui-cover__label">{{ title() }}</span>
      }
    }
  `,
  host: {
    class: 'ui-cover',
    'aria-hidden': 'true',
    '[class.ui-cover--icon]': 'icon() !== null',
    '[style.--ui-cover-size.px]': 'size()',
    '[style.--ui-cover-from]': 'colors()[0]',
    '[style.--ui-cover-to]': 'colors()[1]',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiCover {
  readonly title = input('');
  readonly size = input(48);
  /** An icon instead of the initials (pinned items, conversations). */
  readonly icon = input<IconName | null>(null);
  /** Fixed colours, else from the title. */
  readonly from = input<string | null>(null);
  readonly to = input<string | null>(null);
  readonly label = input(true);
  protected readonly code = computed(() => coverCode(this.title()));
  protected readonly colors = computed((): readonly [string, string] => {
    const from = this.from();
    const to = this.to();
    return from && to ? [from, to] : coverGradient(this.title());
  });
  protected readonly iconSize = computed(() => Math.round(this.size() * 0.42));
  protected readonly showLabel = computed(
    () => this.label() && this.size() >= 120,
  );
}
