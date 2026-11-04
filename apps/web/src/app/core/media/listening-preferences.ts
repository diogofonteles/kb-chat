import { Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  MEDIA_SKIP_BACK_SECONDS,
  MEDIA_SKIP_FORWARD_SECONDS,
  MediaPreferences,
} from '@kb-chat/contracts';
import {
  DEFAULT_SPEED,
  stepSpeed,
  type PlaybackSpeed,
} from '@kb-chat/player-core';
import { EMPTY, Subject, catchError, concatMap } from 'rxjs';
import { ListeningApi } from './listening-api.js';
import { MediaEngine } from './media-engine.js';

const DEFAULTS: MediaPreferences = {
  speed: DEFAULT_SPEED,
  showRemaining: true,
  skipBackSec: 15,
  skipForwardSec: 30,
  skipSilences: false,
  wordHighlight: true,
};

export type SkipBackSeconds = (typeof MEDIA_SKIP_BACK_SECONDS)[number];
export type SkipForwardSeconds = (typeof MEDIA_SKIP_FORWARD_SECONDS)[number];

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
  /** Saves go one after the other: the account ends with the last choice (FR-1). */
  private readonly saves = new Subject<MediaPreferences>();
  /** A choice made here before the account answered wins over that answer. */
  private changed = false;

  readonly value = this.current.asReadonly();
  /** How far "Voltar" and "Avançar" go, everywhere (buttons, J/L, lock screen; KBC-043). */
  readonly skipBackMs = computed(() => this.current().skipBackSec * 1000);
  readonly skipForwardMs = computed(() => this.current().skipForwardSec * 1000);

  constructor() {
    this.saves
      .pipe(
        concatMap((preferences) =>
          this.api.savePreferences(preferences).pipe(catchError(() => EMPTY)),
        ),
        takeUntilDestroyed(),
      )
      .subscribe();
  }

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

  setSkipBack(skipBackSec: SkipBackSeconds): void {
    this.save({ ...this.current(), skipBackSec });
  }

  setSkipForward(skipForwardSec: SkipForwardSeconds): void {
    this.save({ ...this.current(), skipForwardSec });
  }

  /** "Encurtar silêncios" (KBC-044), for every media and device (BR-2: off by default). */
  setSkipSilences(skipSilences: boolean): void {
    this.save({ ...this.current(), skipSilences });
  }

  /** "Destacar palavra a palavra" (KBC-045), for every media and device: starts on. */
  setWordHighlight(wordHighlight: boolean): void {
    this.save({ ...this.current(), wordHighlight });
  }

  toggleShowRemaining(): void {
    const preferences = this.current();
    this.save({ ...preferences, showRemaining: !preferences.showRemaining });
  }

  private save(preferences: MediaPreferences): void {
    this.changed = true;
    this.current.set(preferences);
    this.saves.next(preferences);
  }
}
