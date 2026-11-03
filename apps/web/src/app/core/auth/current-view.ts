import { DOCUMENT } from '@angular/common';
import { Injectable, InjectionToken, inject, signal } from '@angular/core';

/**
 * VIEW_HEADER and OWN_VIEW of @kb-chat/contracts, copied so the first bundle stays free of
 * the contracts (and zod); a unit test keeps them equal.
 */
export const VIEW = { header: 'x-kb-chat-view', own: 'self' } as const;

/** Reloads the app at its home page in the view the server has now (KBC-060). */
export const RELOAD_VIEW = new InjectionToken<() => void>('RELOAD_VIEW', {
  providedIn: 'root',
  factory: () => {
    const view = inject(DOCUMENT).defaultView;
    return () => view?.location.assign('/');
  },
});

/**
 * Whose view this tab shows (KBC-060): `self`, or the person a master acts as. Every write
 * says it, so the server refuses one from a tab whose view the session no longer has.
 */
@Injectable({ providedIn: 'root' })
export class CurrentView {
  private readonly value = signal<string | null>(null);
  readonly id = this.value.asReadonly();

  set(id: string | null): void {
    this.value.set(id);
  }
}

/** The channel the app's tabs hear a change of view on (KBC-060). */
export const VIEW_CHANNEL = 'kb-chat.view';

/** Tells the app's other tabs the view changed (they reload in the current one). */
export function announceViewChange(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(VIEW_CHANNEL);
  channel.postMessage('changed');
  channel.close();
}
