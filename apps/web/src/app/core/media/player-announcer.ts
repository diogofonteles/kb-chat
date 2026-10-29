import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { PlaybackPhase, PlaybackSpeed } from '@kb-chat/player-core';
import { speak } from '@core/i18n/spoken-time.js';
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
  private seekTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly phase = computed(() => this.engine.playback().phase);
  private readonly seeking = computed(() => this.engine.playback().userSeeking);

  /** The region's text; a repeat differs by a trailing space so it is read again. */
  readonly message = this.text.asReadonly();
  readonly count = this.said.asReadonly();
  /** Set by the time slider while focused: the region stays quiet. */
  readonly sliderFocused = signal(false);

  constructor() {
    let previousPhase: PlaybackPhase | null = null;
    effect(() => {
      const phase = this.phase();
      untracked(() => {
        if (phase === 'playing' && previousPhase !== 'playing')
          this.say($localize`:@@player.announce.playing:Tocando`);
        if (phase === 'paused' && previousPhase === 'playing')
          this.say($localize`:@@player.announce.paused:Pausado`);
        previousPhase = phase;
      });
    });
    let previousSpeed: PlaybackSpeed | null = null;
    effect(() => {
      const speed = this.engine.speed();
      untracked(() => {
        if (previousSpeed !== null && speed !== previousSpeed)
          this.say(speedText(speed));
        previousSpeed = speed;
      });
    });
    let landed = 0;
    effect(() => {
      const count = this.engine.seeksLanded();
      untracked(() => {
        if (count > landed) this.positionSoon();
        landed = count;
      });
    });
  }

  /** A skip landed: say where, once the person stops skipping. */
  private positionSoon(): void {
    if (this.seekTimer) clearTimeout(this.seekTimer);
    this.seekTimer = setTimeout(() => {
      this.seekTimer = null;
      this.say(
        $localize`:@@player.announce.position:Posição ${speak(this.engine.playback().currentMs)}:position:`,
      );
    }, ANNOUNCE_SEEK_AFTER_MS);
  }

  private say(message: string): void {
    if (this.sliderFocused()) return;
    const repeat = message === this.text().trim();
    this.text.set(
      repeat && !this.text().endsWith(' ') ? `${message} ` : message,
    );
    this.said.update((count) => count + 1);
  }
}
