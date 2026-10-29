import { Injectable, inject, signal } from '@angular/core';
import {
  shortcutOf,
  type ShortcutAction,
  type ShortcutTarget,
} from '@kb-chat/player-core';
import { ListeningPreferences } from '@core/media/listening-preferences.js';
import { MediaEngine } from '@core/media/media-engine.js';

export const SKIP_BACK_MS = 15_000;
export const SKIP_FORWARD_MS = 30_000;

const STORAGE_KEY = 'kb-chat.player.single-key';

/** Where the focus is, as the shortcuts care about it (BR-5). */
export function targetOf(target: EventTarget | null): ShortcutTarget {
  if (!(target instanceof Element)) return 'page';
  if (target.closest('dialog, [role="dialog"], [role="alertdialog"]'))
    return 'dialog';
  if (target.closest('[role="menu"], [role^="menuitem"]')) return 'menu';
  if (target.matches('input[type="range"], [role="slider"]')) return 'slider';
  if (
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
    )
  )
    return 'field';
  if (target.closest('button, a[href], summary, [role="button"]'))
    return 'button';
  return 'page';
}

function storedEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

/**
 * The player's single-key shortcuts (screens.md T15, KBC-041 FR-6): the player page and
 * the mini-player hand their key presses here; the rule of `@kb-chat/player-core` decides,
 * and only a key that acts is taken from the browser. "Usar atalhos de uma tecla" turns
 * them all off and is remembered in this browser (WCAG 2.1.4).
 */
@Injectable({ providedIn: 'root' })
export class PlayerShortcuts {
  private readonly engine = inject(MediaEngine);
  private readonly preferences = inject(ListeningPreferences);
  private readonly on = signal(storedEnabled());
  private readonly help = signal(0);

  readonly enabled = this.on.asReadonly();
  /** Grows each time "?" asks for the shortcuts list. */
  readonly helpAsked = this.help.asReadonly();

  setEnabled(enabled: boolean): void {
    this.on.set(enabled);
    try {
      localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
    } catch {
      // Not remembered in a private window; still in use now.
    }
  }

  handle(event: KeyboardEvent): void {
    if (event.defaultPrevented || !this.engine.source()) return;
    const action = shortcutOf(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        target: targetOf(event.target),
      },
      this.on(),
    );
    if (!action) return;
    event.preventDefault();
    this.run(action);
  }

  private run(action: ShortcutAction): void {
    const engine = this.engine;
    const actions: {
      readonly [K in ShortcutAction['kind']]: (
        action: Extract<ShortcutAction, { kind: K }>,
      ) => void;
    } = {
      toggle: () => engine.toggle(),
      back: () => engine.skip(-SKIP_BACK_MS),
      forward: () => engine.skip(SKIP_FORWARD_MS),
      'seek-by': ({ deltaMs }) => engine.skip(deltaMs),
      speed: ({ direction }) => this.preferences.stepSpeed(direction),
      mute: () => engine.toggleMute(),
      'seek-fraction': ({ fraction }) => {
        const durationMs = engine.playback().durationMs;
        if (durationMs) engine.seek(durationMs * fraction);
      },
      help: () => this.help.update((count) => count + 1),
    };
    (actions[action.kind] as (action: ShortcutAction) => void)(action);
  }
}
