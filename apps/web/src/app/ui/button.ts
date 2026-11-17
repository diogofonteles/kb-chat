import { Directive, input } from '@angular/core';

/** The six v2 buttons (v2 · Componentes › Botão), all pills. */
export type ButtonKind =
  'primary' | 'white' | 'outline' | 'ghost' | 'danger' | 'dark';
/** sm 32 · md 44 (default) · lg 52 (the entry screens on a phone, the page's main action). */
export type ButtonSize = 'sm' | 'md' | 'lg';

/**
 * A v2 button on a native `<button>` or `<a>` (KBC-124 FR-3): `<button uiButton="white">`.
 * The look is in styles/ui.css (`.ui-btn`), so focus, disabled and hover are the same in
 * every theme; `block` makes it fill its column.
 */
@Directive({
  selector: '[uiButton]',
  host: {
    class: 'ui-btn',
    '[class.ui-btn--primary]': "kind() === 'primary' || kind() === ''",
    '[class.ui-btn--white]': "kind() === 'white'",
    '[class.ui-btn--outline]': "kind() === 'outline'",
    '[class.ui-btn--ghost]': "kind() === 'ghost'",
    '[class.ui-btn--danger]': "kind() === 'danger'",
    '[class.ui-btn--dark]': "kind() === 'dark'",
    '[class.ui-btn--sm]': "size() === 'sm'",
    '[class.ui-btn--lg]': "size() === 'lg'",
    '[class.ui-btn--block]': 'block()',
  },
})
export class UiButton {
  readonly kind = input<ButtonKind | ''>('', { alias: 'uiButton' });
  readonly size = input<ButtonSize>('md');
  readonly block = input(false);
}

/** Round icon-only buttons: plain (no fill), play (green), circle and surface (filled). */
export type IconButtonKind = 'plain' | 'play' | 'circle' | 'surface';

/**
 * A v2 icon button (v2 · Componentes › Botão de ícone). It has no text: give it an
 * `aria-label`. Size in px, 32 by default (the desktop floor); phones get 44 in ui.css.
 */
@Directive({
  selector: '[uiIconButton]',
  host: {
    class: 'ui-icon-btn',
    '[class.ui-icon-btn--play]': "kind() === 'play'",
    '[class.ui-icon-btn--circle]': "kind() === 'circle'",
    '[class.ui-icon-btn--surface]': "kind() === 'surface'",
    '[style.--ui-icon-btn-size.px]': 'size()',
  },
})
export class UiIconButton {
  readonly kind = input<IconButtonKind | ''>('', { alias: 'uiIconButton' });
  readonly size = input(32);
}

/**
 * A v2 chip (v2 · Componentes › Chip): a pill that filters or picks. `selected` sets
 * aria-pressed (white with black text when on); leave it null for a chip that opens a menu.
 */
@Directive({
  selector: '[uiChip]',
  host: {
    class: 'ui-chip',
    '[attr.aria-pressed]': 'selected()',
  },
})
export class UiChip {
  readonly selected = input<boolean | null>(null);
}
