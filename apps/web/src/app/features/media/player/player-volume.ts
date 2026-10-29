import { Injectable, inject } from '@angular/core';
import { MediaEngine } from '@core/media/media-engine.js';

const STORAGE_KEY = 'kb-chat.player.volume';

/** The volume the person chose, remembered in this browser (KBC-041 FR-9). */
@Injectable({ providedIn: 'root' })
export class PlayerVolume {
  private readonly engine = inject(MediaEngine);
  private restored = false;

  /** Gives the engine the remembered volume, once per app. */
  restore(): void {
    if (this.restored) return;
    this.restored = true;
    try {
      const kept = localStorage.getItem(STORAGE_KEY);
      const volume = kept === null ? Number.NaN : Number(kept);
      if (Number.isFinite(volume)) this.engine.setVolume(volume);
    } catch {
      // Nothing remembered: the element's own volume stays.
    }
  }

  set(volume: number): void {
    this.engine.setVolume(volume);
    try {
      localStorage.setItem(STORAGE_KEY, String(this.engine.volume()));
    } catch {
      // In use now, not remembered.
    }
  }
}
