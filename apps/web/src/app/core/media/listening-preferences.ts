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
import { EMPTY, Subject, catchError, concatMap, type Observable } from 'rxjs';
import { ListeningApi, type PlayerChange } from './listening-api.js';
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
 * Only what changed is sent: what this tab holds of the rest may be old, or the defaults,
 * and must not overwrite a choice made on another tab or device (KBC-045).
 */
@Injectable({ providedIn: 'root' })
export class ListeningPreferences {
  private readonly api = inject(ListeningApi);
  private readonly engine = inject(MediaEngine);
  private readonly current = signal<MediaPreferences>(DEFAULTS);
  private loading = false;
  /** Saves go one after the other: the account ends with the last choice (FR-1). */
  private readonly saves = new Subject<PlayerChange>();
  /** The choices made here: one made before the account answered wins over that answer. */
  private chosen: PlayerChange = {};
  /** What the last save failed to keep: it goes again with the next change. */
  private unsaved: PlayerChange = {};

  readonly value = this.current.asReadonly();
  /** How far "Voltar" and "Avançar" go, everywhere (buttons, J/L, lock screen; KBC-043). */
  readonly skipBackMs = computed(() => this.current().skipBackSec * 1000);
  readonly skipForwardMs = computed(() => this.current().skipForwardSec * 1000);

  constructor() {
    this.saves
      .pipe(
        concatMap((change) => this.send(change)),
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
        const known = { ...preferences, ...this.chosen };
        this.current.set(known);
        this.engine.setSpeed(known.speed);
      },
      error: () => (this.loading = false),
    });
  }

  setSpeed(speed: PlaybackSpeed): void {
    this.engine.setSpeed(speed);
    this.save({ speed });
  }

  stepSpeed(direction: 1 | -1): void {
    this.setSpeed(stepSpeed(this.current().speed, direction));
  }

  setSkipBack(skipBackSec: SkipBackSeconds): void {
    this.save({ skipBackSec });
  }

  setSkipForward(skipForwardSec: SkipForwardSeconds): void {
    this.save({ skipForwardSec });
  }

  /** "Encurtar silêncios" (KBC-044), for every media and device (BR-2: off by default). */
  setSkipSilences(skipSilences: boolean): void {
    this.save({ skipSilences });
  }

  /** "Destacar palavra a palavra" (KBC-045), for every media and device: starts on. */
  setWordHighlight(wordHighlight: boolean): void {
    this.save({ wordHighlight });
  }

  toggleShowRemaining(): void {
    this.save({ showRemaining: !this.current().showRemaining });
  }

  private save(change: PlayerChange): void {
    this.chosen = { ...this.chosen, ...change };
    this.current.update((preferences) => ({ ...preferences, ...change }));
    this.saves.next(change);
  }

  private send(change: PlayerChange): Observable<MediaPreferences> {
    const toSave = { ...this.unsaved, ...change };
    this.unsaved = {};
    return this.api.savePreferences(toSave).pipe(
      catchError(() => {
        this.unsaved = toSave;
        return EMPTY;
      }),
    );
  }
}
