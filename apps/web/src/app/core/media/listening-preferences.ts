import { Injectable, inject, signal } from '@angular/core';
import type { MediaPreferences } from '@kb-chat/contracts';
import {
  DEFAULT_SPEED,
  stepSpeed,
  type PlaybackSpeed,
} from '@kb-chat/player-core';
import { ListeningApi } from './listening-api.js';
import { MediaEngine } from './media-engine.js';

const DEFAULTS: MediaPreferences = {
  speed: DEFAULT_SPEED,
  showRemaining: true,
};

/**
 * The person's speed and time display (KBC-041 FR-1, BR-1): read from the account once,
 * applied to the engine, and saved on every change. A change is used at once; when the
 * account cannot be reached, the choice stays in use and the next change saves it again.
 */
@Injectable({ providedIn: 'root' })
export class ListeningPreferences {
  private readonly api = inject(ListeningApi);
  private readonly engine = inject(MediaEngine);
  private readonly current = signal<MediaPreferences>(DEFAULTS);
  private loading = false;
  /** A choice made here before the account answered wins over that answer. */
  private changed = false;

  readonly value = this.current.asReadonly();

  /** Reads the account's choices; asked by the player, only the first call reads. */
  load(): void {
    if (this.loading) return;
    this.loading = true;
    this.api.preferences().subscribe({
      next: (preferences) => {
        if (this.changed) return;
        this.current.set(preferences);
        this.engine.setSpeed(preferences.speed);
      },
      error: () => (this.loading = false),
    });
  }

  setSpeed(speed: PlaybackSpeed): void {
    this.engine.setSpeed(speed);
    this.save({ ...this.current(), speed });
  }

  stepSpeed(direction: 1 | -1): void {
    this.setSpeed(stepSpeed(this.current().speed, direction));
  }

  toggleShowRemaining(): void {
    const preferences = this.current();
    this.save({ ...preferences, showRemaining: !preferences.showRemaining });
  }

  private save(preferences: MediaPreferences): void {
    this.changed = true;
    this.current.set(preferences);
    this.api.savePreferences(preferences).subscribe({ error: () => undefined });
  }
}
