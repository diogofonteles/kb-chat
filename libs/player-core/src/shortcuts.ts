/**
 * The player's single-key shortcuts (screens.md T15, KBC-041 FR-6), as a pure rule: what a
 * key does given where the focus is. They never act in a field, a menu or a dialog, nor
 * with modifier keys, and the person can turn them all off (BR-5, WCAG 2.1.4).
 */
export type ShortcutAction =
  | { readonly kind: 'toggle' }
  | { readonly kind: 'back' }
  | { readonly kind: 'forward' }
  | { readonly kind: 'seek-by'; readonly deltaMs: number }
  | { readonly kind: 'speed'; readonly direction: 1 | -1 }
  | { readonly kind: 'mute' }
  | { readonly kind: 'seek-fraction'; readonly fraction: number }
  | { readonly kind: 'help' };

/** Where the focus is, as the shortcuts care about it. */
export type ShortcutTarget =
  'page' | 'button' | 'slider' | 'field' | 'menu' | 'dialog';

export interface KeyPress {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly target: ShortcutTarget;
}

const ARROW_STEP_MS = 5_000;

const LETTERS: Readonly<Record<string, ShortcutAction>> = {
  k: { kind: 'toggle' },
  j: { kind: 'back' },
  l: { kind: 'forward' },
  m: { kind: 'mute' },
  '?': { kind: 'help' },
  '<': { kind: 'speed', direction: -1 },
  '>': { kind: 'speed', direction: 1 },
  ArrowLeft: { kind: 'seek-by', deltaMs: -ARROW_STEP_MS },
  ArrowRight: { kind: 'seek-by', deltaMs: ARROW_STEP_MS },
};

/** Shift+, and Shift+. are the speed keys on any layout (some report the unshifted key). */
const SHIFTED: Readonly<Record<string, string>> = { ',': '<', '.': '>' };

/**
 * Shortcut keys a focused control already uses itself, so the shortcut must not act a
 * second time: a button presses on Space, the time slider moves on the arrows (AC-8).
 */
const CONSUMED: Readonly<Partial<Record<ShortcutTarget, readonly string[]>>> = {
  button: [' '],
  slider: ['ArrowLeft', 'ArrowRight'],
};

export function shortcutOf(
  press: KeyPress,
  enabled: boolean,
): ShortcutAction | null {
  const { target } = press;
  if (!enabled || press.ctrlKey || press.metaKey || press.altKey) return null;
  if (target === 'field' || target === 'menu' || target === 'dialog')
    return null;
  if (CONSUMED[target]?.includes(press.key)) return null;
  if (press.key === ' ') return { kind: 'toggle' };
  if (/^[0-9]$/.test(press.key))
    return { kind: 'seek-fraction', fraction: Number(press.key) / 10 };
  const key = (press.shiftKey && SHIFTED[press.key]) || press.key;
  return LETTERS[key.length === 1 ? key.toLowerCase() : key] ?? null;
}
