import { Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import type { PlaybackSpeed } from '@kb-chat/player-core';
import { speak } from '@core/i18n/spoken-time.js';
import { debounceTime, filter, map, merge, pairwise, skip } from 'rxjs';
import { MediaEngine } from './media-engine.js';

/** Skips closer than this make one announcement, with the final position (AC-15). */
export const ANNOUNCE_SEEK_AFTER_MS = 700;

const speedText = (speed: PlaybackSpeed): string =>
  speed === 1
    ? $localize`:@@player.announce.normalSpeed:Velocidade normal`
    : $localize`:@@player.announce.speed:Velocidade ${new Intl.NumberFormat('pt-BR').format(speed)}:speed: vezes`;

/**
 * What the player's `role="status"` region says (KBC-041 FR-10, screens.md T15): only
 * confirmed changes ("Tocando", "Pausado", the speed, the position after skips, joined into
 * one), never every second, and nothing while the time slider has the focus (it speaks).
 */
@Injectable({ providedIn: 'root' })
export class PlayerAnnouncer {
  private readonly engine = inject(MediaEngine);
  private readonly text = signal('');
  private readonly said = signal(0);
  private readonly sliderHasFocus = signal(false);
  /** Said in place of the next "Pausado" (a pause someone else asked for, with a reason). */
  private nextPause: string | null = null;
  private readonly phase = computed(() => this.engine.playback().phase);

  /** The region's text; a repeat differs by a trailing space so it is read again. */
  readonly message = this.text.asReadonly();
  readonly count = this.said.asReadonly();

  constructor() {
    const playing = toObservable(this.phase).pipe(
      pairwise(),
      map(([before, now]) => {
        if (now === 'playing' && before !== 'playing')
          return $localize`:@@player.announce.playing:Tocando`;
        if (now === 'paused' && before === 'playing') {
          const reason = this.nextPause;
          this.nextPause = null;
          return reason ?? $localize`:@@player.announce.paused:Pausado`;
        }
        return null;
      }),
    );
    const speed = toObservable(this.engine.speed).pipe(skip(1), map(speedText));
    // The skips the person made, once they stop skipping: where they landed.
    const position = toObservable(this.engine.seeksLanded).pipe(
      filter((landed) => landed > 0),
      debounceTime(ANNOUNCE_SEEK_AFTER_MS),
      map(
        () =>
          $localize`:@@player.announce.position:Posição ${speak(this.engine.playback().currentMs)}:position:`,
      ),
    );
    merge(playing, speed, position)
      .pipe(
        filter((message): message is string => message !== null),
        takeUntilDestroyed(),
      )
      .subscribe((message) => this.say(message));
  }

  /** Says `message` instead of "Pausado" for the pause about to come (the sleep timer). */
  sayOnNextPause(message: string): void {
    this.nextPause = message;
  }

  /** The time slider has the focus (it speaks the time itself): the region keeps quiet. */
  setSliderFocused(focused: boolean): void {
    this.sliderHasFocus.set(focused);
  }

  /** Says a confirmed change in the status region (also used by the sleep timer). */
  say(message: string): void {
    if (this.sliderHasFocus()) return;
    const repeat = message === this.text().trim();
    this.text.set(
      repeat && !this.text().endsWith(' ') ? `${message} ` : message,
    );
    this.said.update((count) => count + 1);
  }
}
