import { Injectable, signal } from '@angular/core';

/** The tabs of the player's right panel (v2 · Mídia — Player): Sobre, Fila, Ouvidas. */
export type PlayerPanelTab = 'about' | 'queue' | 'recent';

/**
 * Which tab of the player's right panel shows. Root-provided, so the player bar's queue
 * button and the player page agree on it while the panel stays the same.
 */
@Injectable({ providedIn: 'root' })
export class PlayerPanelTabs {
  readonly tab = signal<PlayerPanelTab>('about');
}
